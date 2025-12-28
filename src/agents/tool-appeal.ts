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
3. User explicitly confirmed/approved this command when asked
4. Command is a direct response to user's explicit instruction

DENY the appeal if:
- Claude decided to run this command autonomously without user request
- User's request was vague and doesn't specifically require this command
- No clear user intent to run this specific command

Reply with EXACTLY one line:
APPROVE
or
DENY: <reason>`,
      },
    ],
  });

  const decision = (
    response.content[0] as { type: 'text'; text: string }
  ).text.trim();

  if (decision.startsWith('DENY')) {
    const reason = decision.replace('DENY: ', '');
    await logToHomeAssistant({
      agent: 'tool-appeal',
      level: 'decision',
      problem: command,
      answer: `DENIED: ${reason}`,
    });
    return { approved: false, reason };
  }

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: command,
    answer: 'APPROVED',
  });
  return { approved: true };
}
