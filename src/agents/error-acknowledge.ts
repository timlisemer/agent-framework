import Anthropic from '@anthropic-ai/sdk';
import { getModelId } from '../types.js';
import { logToHomeAssistant } from '../utils/logger.js';
import {
  isErrorAcknowledged,
  markErrorAcknowledged,
} from '../utils/ack-cache.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

// Pattern to extract error text from transcript for caching
const ERROR_EXTRACT_PATTERN =
  /error TS\d+[^\n]*|Error:[^\n]*|failed[^\n]*|FAILED[^\n]*/i;

export async function checkErrorAcknowledgment(
  transcript: string,
  toolName: string,
  toolInput: unknown
): Promise<string> {
  // Check if the error in this transcript was already acknowledged
  const errorMatch = transcript.match(ERROR_EXTRACT_PATTERN);
  if (errorMatch && isErrorAcknowledged(errorMatch[0])) {
    await logToHomeAssistant({
      agent: 'error-acknowledge',
      level: 'decision',
      problem: `${toolName} (cached)`,
      answer: 'OK - error already acknowledged',
    });
    return 'OK';
  }
  const response = await anthropic.messages.create({
    model: getModelId('haiku'),
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `You are an error acknowledgment validator. Analyze the recent transcript to determine if the AI is ignoring errors or user feedback.

TRANSCRIPT (recent messages):
${transcript}

CURRENT TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}

=== WHAT TO DETECT ===

1. A tool returned an error message (TypeScript errors, build failures, hook denials)
2. The user provided feedback/correction (especially caps, directives)
3. The AI is now calling a tool WITHOUT acknowledging the error in its text response

=== RETURN "OK" WHEN ===

- No recent errors in transcript
- AI's text explicitly acknowledges the error before this tool call
- This tool call is directly addressing/fixing the error (e.g., Edit to fix the error)
- The tool call is Read/Grep to investigate the error further

=== RETURN "BLOCK: <message>" WHEN ===

- Error exists in recent transcript
- AI said nothing about the error (no ASSISTANT text after the error)
- AI is calling an unrelated tool (not fixing or investigating the error)
- User gave explicit directive that AI ignored

The message should tell the AI what it needs to acknowledge before proceeding.

=== OUTPUT FORMAT (STRICT) ===
Your response MUST be EXACTLY one of:

OK
OR
BLOCK: [ERROR: "<quote the specific error from transcript>"] <what AI needs to acknowledge>

Example: BLOCK: [ERROR: "error TS2304: Cannot find name 'foo'"] Acknowledge this TypeScript error before proceeding.

NO other text. NO explanations. Just OK or BLOCK: [ERROR: "..."] <message>.`,
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
    // Mark error as acknowledged so future checks skip it
    if (errorMatch) {
      markErrorAcknowledged(errorMatch[0]);
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
    level: 'error',
    problem: toolDescription,
    answer: `Malformed response after retries: ${decision}`,
  });
  return 'OK';
}
