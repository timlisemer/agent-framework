import Anthropic from '@anthropic-ai/sdk';
import { getModelId } from '../types.js';
import { logToHomeAssistant } from '../utils/logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

export async function appealDenial(
  command: string,
  transcript: string,
  originalReason: string
): Promise<{ approved: boolean; reason?: string }> {
  const response = await anthropic.messages.create({
    model: getModelId('haiku'),
    max_tokens: 150,
    messages: [
      {
        role: 'user',
        content: `You are reviewing an appeal of a command denial.

ORIGINAL DECISION: DENIED
ORIGINAL REASON: ${originalReason}
COMMAND: ${command}

RECENT CONVERSATION:
${transcript}

Your role is to determine if the original denial should stand or be overturned based on the conversation context.

UPHOLD THE DENIAL (agree with original) when:
1. User's request was vague and AI inferred the command
   - Example: User said "run check" but AI chose "make check"
   - The original technical reason is correct
2. User didn't explicitly request this specific command
3. Original denial reason is valid and applicable

OVERTURN TO APPROVE when:
- User explicitly typed this exact command
- User invoked a slash command requiring this action (/push, /commit)
- User explicitly confirmed when asked

OVERTURN WITH NEW REASON when:
- User asked for X but AI is autonomously doing Y (clear mismatch)
- User explicitly opposed this command (said no/don't/stop)
- You have important context the original decision missed

CRITICAL: If the original denial is correct and you have no additional context, UPHOLD it.
Only overturn if you have a compelling reason from the transcript.

Reply with EXACTLY one line:
UPHOLD
or
OVERTURN: APPROVE
or
OVERTURN: <new reason>

Examples:
- User: "run check", Command: "make check", Original: "use MCP tool" → UPHOLD
- User: "please run make check", Command: "make check" → OVERTURN: APPROVE
- User: "run checks", Command: "git commit", Original: "non-read-only" → OVERTURN: User asked for checks, not commit
- User: "don't do that", Command: any → OVERTURN: User explicitly opposed`,
      },
    ],
  });

  let decision = (
    response.content[0] as { type: 'text'; text: string }
  ).text.trim();

  // Retry if malformed (not starting with APPROVE or DENY:)
  let retries = 0;
  const maxRetries = 2;

  while (
    !decision.startsWith('UPHOLD') &&
    !decision.startsWith('OVERTURN:') &&
    decision !== 'DENY' &&
    !decision.startsWith('DENY:') &&
    retries < maxRetries
  ) {
    retries++;

    const retryResponse = await anthropic.messages.create({
      model: getModelId('haiku'),
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Invalid format: "${decision}". Reply with EXACTLY: UPHOLD, OVERTURN: APPROVE, or OVERTURN: <reason>`
      }]
    });

    decision = (retryResponse.content[0] as { type: 'text'; text: string }).text.trim();
  }

  // Check for approval (overturn)
  if (decision.startsWith('OVERTURN: APPROVE') || decision === 'APPROVE') {
    await logToHomeAssistant({
      agent: 'tool-appeal',
      level: 'decision',
      problem: command,
      answer: 'OVERTURNED → APPROVED',
    });
    return { approved: true };
  }

  // Parse denial/uphold - extract reason if provided
  let reason: string | undefined;
  const normalizedDecision = decision.trim().toUpperCase();

  if (normalizedDecision === 'UPHOLD' || normalizedDecision === 'DENY') {
    // Uphold original - no reason needed
    reason = undefined;
  } else if (decision.startsWith('OVERTURN: ')) {
    // Overturn with new reason
    reason = decision.replace('OVERTURN: ', '');
    if (reason === 'APPROVE') reason = undefined; // Already handled above, but safety
  } else if (decision.startsWith('DENY: ')) {
    // Old format compatibility
    reason = decision.replace('DENY: ', '');
  } else if (normalizedDecision.includes('UPHOLD') || normalizedDecision.includes('DENY')) {
    // Formatting issue but clear intent to uphold
    reason = undefined;
  } else {
    // Truly malformed
    reason = `Malformed response after ${retries} retries: ${decision}`;
  }

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: command,
    answer: reason ? `DENIED: ${reason}` : 'UPHELD (using original reason)',
  });

  return { approved: false, reason };
}
