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
        content: `You are reviewing an appeal. The command was denied for a valid technical reason.

DENIAL REASON: ${originalReason}
COMMAND: ${command}

RECENT CONVERSATION:
${transcript}

The original denial is ALWAYS technically correct. Your ONLY job is to check if the user explicitly approved this command or if there's a mismatch.

OVERTURN TO APPROVE when:
- User explicitly typed this exact command (e.g., "run make check", "execute git push")
- User invoked a slash command requiring this (/push, /commit)
- User explicitly confirmed when asked
→ The user knowingly wants this despite the technical restriction

OVERTURN WITH NEW REASON when:
- User asked for X but AI is autonomously doing Y (clear mismatch)
  Example: User said "run checks" but AI is doing "git commit"
  Reply: OVERTURN: User asked for checks, not commit
- User explicitly opposed this command (said no/don't/stop)
  Reply: OVERTURN: User explicitly opposed

UPHOLD (default) when:
- User's request was vague (e.g., "run check" → AI chose "make check")
- No explicit user approval for this exact command
- Anything unclear
→ The original technical reason stands

CRITICAL: You are NOT judging if the technical rule is correct (it always is).
You are ONLY checking if the user explicitly approved this specific command.

Reply with EXACTLY one line:
UPHOLD
or
OVERTURN: APPROVE
or
OVERTURN: <new reason>

Examples:
- User: "run check", Command: "make check" → UPHOLD
- User: "please run make check", Command: "make check" → OVERTURN: APPROVE
- User: "run checks", Command: "git commit" → OVERTURN: User asked for checks, not commit
- User: "don't do that" → OVERTURN: User explicitly opposed`,
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

  // CODE-LEVEL SAFEGUARD: If response contains UPHOLD in any form, ALWAYS return undefined
  // This ensures the original tool-approve reason is used, regardless of LLM output
  if (normalizedDecision.includes('UPHOLD')) {
    reason = undefined;
  } else if (decision.startsWith('OVERTURN: ')) {
    // Overturn with new reason - ONLY case where appeal provides a reason
    reason = decision.replace('OVERTURN: ', '');
    if (reason === 'APPROVE') reason = undefined; // Already handled above, but safety
  } else if (decision.startsWith('DENY: ')) {
    // Old format compatibility - appeal provides reason
    reason = decision.replace('DENY: ', '');
  } else if (normalizedDecision === 'DENY') {
    // Bare DENY - defer to original
    reason = undefined;
  } else {
    // Truly malformed - treat as uphold to be safe (defer to original)
    reason = undefined;
  }

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: command,
    answer: reason ? `DENIED: ${reason}` : 'UPHELD (using original reason)',
  });

  return { approved: false, reason };
}
