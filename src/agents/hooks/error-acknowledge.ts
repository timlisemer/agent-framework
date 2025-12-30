import Anthropic from '@anthropic-ai/sdk';
import { getModelId } from '../../types.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import {
  isErrorAcknowledged,
  markErrorAcknowledged,
} from '../../utils/ack-cache.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

// Pattern to extract issue text from transcript for caching
const ISSUE_EXTRACT_PATTERN =
  /error TS\d+[^\n]*|Error:[^\n]*|failed[^\n]*|FAILED[^\n]*/i;

export async function checkErrorAcknowledgment(
  transcript: string,
  toolName: string,
  toolInput: unknown
): Promise<string> {
  // Check if the issue in this transcript was already acknowledged
  const issueMatch = transcript.match(ISSUE_EXTRACT_PATTERN);
  if (issueMatch && isErrorAcknowledged(issueMatch[0])) {
    await logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: `${toolName} (cached)`,
      answer: 'OK - issue already acknowledged',
    });
    return 'OK';
  }
  const response = await anthropic.messages.create({
    model: getModelId('haiku'),
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `You are an issue acknowledgment validator.

TRANSCRIPT (recent messages):
${transcript}

CURRENT TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}

=== WHAT COUNTS AS A REAL ISSUE ===

Real issues that need acknowledgment:
- TypeScript errors: "error TS2304: Cannot find name 'foo'" at src/file.ts:42
- Build failures: "make: *** [Makefile:10: build] Error 1"
- Test failures: "FAILED tests/foo.test.ts" with actual failure reason
- Hook denials with SPECIFIC reason: "DENY: modifying system files outside project"
- User directives in ALL CAPS or explicit corrections

NOT real issues (ignore these):
- Source code from Read/Grep containing words like "error", "failed", "denied"
- Generic text like "The tool call was denied for a valid technical reason"
- Variable names like "errorHandler" or "onFailure"
- System prompts or documentation text being read/written
- Strings inside code that happen to contain error-like words

=== RETURN "OK" WHEN ===

- No real issues in transcript (just source code content)
- AI explicitly acknowledged the issue in its text before this tool call
- This tool call directly addresses/fixes the issue
- Tool call is Read/Grep to investigate further

=== RETURN "BLOCK" WHEN ===

- A REAL issue exists (build failure, TypeScript error, test failure)
- AI said nothing about it after the issue appeared
- AI is calling an unrelated tool instead of fixing it
- User gave explicit directive that AI ignored

=== OUTPUT FORMAT (STRICT) ===
Your response MUST be EXACTLY one of:

OK
OR
BLOCK: [ISSUE: "<exact error with file:line or error code>"] <what to acknowledge>

Good example:
BLOCK: [ISSUE: "error TS2304: Cannot find name 'foo' at src/types.ts:42"] Fix this TypeScript error.

Bad example (DO NOT DO THIS):
BLOCK: [ISSUE: "The tool call was denied"] - This is useless, not a real error.

NO other text. Just OK or BLOCK with a SPECIFIC, USEFUL issue quote.`,
      },
    ],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  let decision = textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

  // Retry if malformed
  let retries = 0;
  const maxRetries = 1;

  while (
    !decision.startsWith('OK') &&
    !decision.startsWith('BLOCK:') &&
    retries < maxRetries
  ) {
    retries++;

    const retryResponse = await anthropic.messages.create({
      model: getModelId('haiku'),
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: `Invalid format: "${decision}". Reply with EXACTLY: OK or BLOCK: <message>`,
        },
      ],
    });

    const retryTextBlock = retryResponse.content.find(
      (block) => block.type === 'text'
    );
    decision =
      retryTextBlock && 'text' in retryTextBlock
        ? retryTextBlock.text.trim()
        : '';
  }

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput).slice(0, 100)}`;

  if (decision.startsWith('OK')) {
    // Mark issue as acknowledged so future checks skip it
    if (issueMatch) {
      markErrorAcknowledged(issueMatch[0]);
    }
    await logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: toolDescription,
      answer: 'OK',
    });
    return 'OK';
  }

  if (decision.startsWith('BLOCK:')) {
    const reason = decision.substring(7).trim();
    await logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: toolDescription,
      answer: `BLOCKED: ${reason}`,
    });
    return decision;
  }

  // Default to OK if response is malformed after retries (fail open)
  await logToHomeAssistant({
    agent: 'error-acknowledge',
    level: 'info',
    problem: toolDescription,
    answer: `Malformed response after retries: ${decision}`,
  });
  return 'OK';
}
