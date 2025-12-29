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

APPROVE the appeal if ANY of these are true:
1. User invoked a slash command that requires this action (e.g., /push, /commit)
2. User explicitly requested this exact command in their message
3. User explicitly confirmed/approved this command
4. Command is a direct response to user's explicit instruction

APPROVAL KEYWORDS - Look for these exact phrases in the recent conversation:
- "user approved"
- "this is user approved"
- "user explicitly requested"
- "user confirmed"
- "proceed with"
- "go ahead"
- "run this command"
- "execute this"

If you see ANY of these approval keywords in the RECENT CONVERSATION section referring to the current command, APPROVE the appeal.

IMPORTANT: The keyword must appear in the MOST RECENT user messages (last 1-3 messages). Ignore older approval keywords that may refer to different commands.

DENY the appeal if:
- Claude decided to run this command autonomously without user request
- User's request was vague and doesn't specifically require this command
- No clear user intent to run this specific command
- User said "user denied" or similar denial keywords

Reply with EXACTLY one line:
APPROVE
or
DENY: <reason>`,
      },
    ],
  });

  let decision = (
    response.content[0] as { type: 'text'; text: string }
  ).text.trim();

  // Retry if malformed (not starting with APPROVE or DENY:)
  let retries = 0;
  const maxRetries = 2;

  while (!decision.startsWith('APPROVE') && !decision.startsWith('DENY:') && retries < maxRetries) {
    retries++;

    const retryResponse = await anthropic.messages.create({
      model: getModelId('haiku'),
      max_tokens: 50,
      messages: [{
        role: 'user',
        content: `Invalid format: "${decision}". You are evaluating an appeal for the command: ${command}. Reply with EXACTLY: APPROVE or DENY: <reason>`
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

  // Default to DENY for safety - extract reason from response
  const reason = decision.startsWith('DENY: ')
    ? decision.replace('DENY: ', '')
    : `Malformed response after ${retries} retries: ${decision}`;

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: command,
    answer: `DENIED: ${reason}`,
  });

  return { approved: false, reason };
}
