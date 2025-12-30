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
        content: `You are an issue acknowledgment validator. Analyze the recent transcript to determine if the AI is ignoring issues or user feedback.

TRANSCRIPT (recent messages):
${transcript}

CURRENT TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}

=== WHAT TO DETECT ===

1. A tool returned an issue message (TypeScript issues, build failures, hook blocks)
2. The user provided feedback/correction (especially caps, directives)
3. The AI is now calling a tool WITHOUT acknowledging the issue in its text response

=== RETURN "OK" WHEN ===

- No recent issues in transcript
- AI's text explicitly acknowledges the issue before this tool call
- This tool call is directly addressing/fixing the issue (e.g., Edit to fix the issue)
- The tool call is Read/Grep to investigate the issue further

=== RETURN "BLOCK: <message>" WHEN ===

- Issue exists in recent transcript
- AI said nothing about the issue (no ASSISTANT text after the issue)
- AI is calling an unrelated tool (not fixing or investigating the issue)
- User gave explicit directive that AI ignored

The message should tell the AI what it needs to acknowledge before proceeding.

=== OUTPUT FORMAT (STRICT) ===
Your response MUST be EXACTLY one of:

OK
OR
BLOCK: [ISSUE: "<quote the specific issue from transcript>"] <what AI needs to acknowledge>

Example: BLOCK: [ISSUE: "TS2304: Cannot find name 'foo'"] Acknowledge this TypeScript issue before proceeding.

NO other text. NO explanations. Just OK or BLOCK: [ISSUE: "..."] <message>.`,
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
