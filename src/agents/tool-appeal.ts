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
        content: `You are an appeal judge for command denials. A command was denied by the first-pass safety check.

COMMAND: ${command}
DENIAL REASON: ${originalReason}

RECENT CONVERSATION:
${transcript}

APPROVE the appeal if the user explicitly requested this exact command:
- User typed the exact command (e.g., "run make check", "execute git push")
- User invoked a slash command that requires this (/push, /commit)
- User explicitly confirmed when asked

DENY the appeal in these cases:

1. VAGUE REQUEST (no reason needed):
   - User's message was ambiguous and AI inferred the command
   - Example: User said "run check" but AI chose "make check"
   - Reply: DENY

2. AI AUTONOMOUS DECISION (provide reason explaining mismatch):
   - User asked for X but AI decided to do Y
   - Example: User said "run checks" but AI tried "git commit"
   - Reply: DENY: User asked for checks, not commit

3. USER OPPOSITION (provide reason):
   - User explicitly said no/don't/stop
   - Reply: DENY: User explicitly opposed the command

Reply with EXACTLY one line:
APPROVE
or
DENY
or
DENY: <reason>

Examples:
- User: "run check", Command: "make check" → DENY
- User: "please run make check", Command: "make check" → APPROVE
- User: "run checks", Command: "git commit" → DENY: User asked for checks, not commit
- User: "don't run that" → DENY: User explicitly opposed the command`,
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
    !decision.startsWith('APPROVE') &&
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
        content: `Invalid format: "${decision}". Reply with EXACTLY: APPROVE, DENY, or DENY: <reason>`
      }]
    });

    decision = (retryResponse.content[0] as { type: 'text'; text: string }).text.trim();
  }

  if (decision.startsWith('APPROVE')) {
    await logToHomeAssistant({
      agent: 'tool-appeal',
      level: 'decision',
      problem: command,
      answer: 'APPROVED',
    });
    return { approved: true };
  }

  // Parse denial - extract reason if provided
  let reason: string | undefined;
  if (decision === 'DENY') {
    // No reason provided - defer to original tool-approve reason
    reason = undefined;
  } else if (decision.startsWith('DENY: ')) {
    // Explicit reason provided (e.g., user said no)
    reason = decision.replace('DENY: ', '');
  } else {
    // Malformed response after retries
    reason = `Malformed response after ${retries} retries: ${decision}`;
  }

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: command,
    answer: reason ? `DENIED: ${reason}` : 'DENIED (no appeal reason)',
  });

  return { approved: false, reason };
}
