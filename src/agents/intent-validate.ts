import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { getModelId, type IntentValidationResult, type IntentContext, type UserMessage } from '../types.js';
import { logToHomeAssistant } from '../utils/logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

const RECENT_MESSAGE_LIMIT = 30;

const SYSTEM_PROMPT = `You are an intent-alignment validator. Your job is to verify AI actions match cumulative user intent.

You will receive:
1. CUMULATIVE USER INTENT: Every user message from the conversation
2. PROPOSED AI ACTION: Tool use or question AI wants to perform

Your task: Determine if the action aligns with what the user actually requested.

CRITICAL MISALIGNMENTS (→ BLOCK):
- AI modifying files user explicitly said not to touch
- AI running commands user said to avoid (e.g., "don't push", "don't delete")
- AI asking questions user already answered clearly in ANY previous message
- AI doing something directly opposite to user's stated goal
- AI proposing destructive changes user never requested

MINOR MISALIGNMENTS (→ WARN):
- AI asking for clarification when user gave vague instructions
- AI making reasonable assumptions on ambiguous requests
- AI proposing extra changes that seem helpful but weren't explicitly requested
- AI repeating a question user partially answered (incomplete answer)

ALLOWED (→ ALLOW):
- Action directly requested by user in ANY message
- Reasonable interpretation of user's goals
- Necessary steps to accomplish user's stated objective
- AI asking for clarification when user's intent is genuinely unclear

RESPONSE FORMAT:
Reply with EXACTLY one of:

ALLOW
or
WARN: <one sentence explaining the minor misalignment>
or
BLOCK: <one sentence explaining the critical misalignment and cite specific user message>

RULES:
- Consider ALL user messages, not just the most recent
- If user said "don't do X" in message 2, and AI tries X in message 10, BLOCK it
- If user answered "where is the config?" in message 3, and AI asks again in message 8, BLOCK it
- Focus on INTENT not exact wording - same intent phrased differently is still answered
- When in doubt between WARN and ALLOW, choose ALLOW
- When in doubt between BLOCK and WARN, choose WARN (only BLOCK clear violations)
- If user changes their mind across messages, the MOST RECENT statement of intent takes precedence`;

export async function extractUserIntent(transcriptPath: string): Promise<IntentContext> {
  try {
    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    const userMessages: UserMessage[] = [];

    lines.forEach((line, idx) => {
      try {
        const entry = JSON.parse(line);

        if (entry.message?.role === 'user') {
          let text = '';

          if (typeof entry.message.content === 'string') {
            text = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            text = entry.message.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text)
              .join('\n');
          }

          if (text.trim()) {
            userMessages.push({
              text: text.trim(),
              messageIndex: idx
            });
          }
        }
      } catch {
        // Skip malformed lines
      }
    });

    // Truncate to recent messages if too many
    const recentMessages = userMessages.length > RECENT_MESSAGE_LIMIT
      ? userMessages.slice(-RECENT_MESSAGE_LIMIT)
      : userMessages;

    const fullIntent = recentMessages
      .map((msg, i) => `[User Message ${i + 1}]:\n${msg.text}`)
      .join('\n\n---\n\n');

    return { userMessages: recentMessages, fullIntent };
  } catch (error) {
    // If transcript doesn't exist or is unreadable, return empty
    return { userMessages: [], fullIntent: '' };
  }
}

export async function validateIntent(
  action: {
    type: 'tool_use';
    toolName?: string;
    toolInput?: unknown;
  },
  transcriptPath: string,
  projectDir: string
): Promise<IntentValidationResult> {
  const intentContext = await extractUserIntent(transcriptPath);

  // No user intent yet - allow everything
  if (intentContext.userMessages.length === 0) {
    return {
      decision: 'ALLOW',
      reason: 'No user intent established yet'
    };
  }

  // Build action description
  const actionDescription = `Tool: ${action.toolName}\nInput: ${JSON.stringify(action.toolInput, null, 2)}`;

  try {
    const response = await anthropic.messages.create({
      model: getModelId('sonnet'),
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `CUMULATIVE USER INTENT (ALL messages):
${intentContext.fullIntent}

---

PROPOSED AI ACTION:
${actionDescription}

Does this action align with user intent? Reply with: ALLOW, WARN: <reason>, or BLOCK: <reason>`
      }],
      system: SYSTEM_PROMPT
    });

    let decision = (response.content[0] as { type: 'text'; text: string }).text.trim();

    // Retry logic for malformed responses
    let retries = 0;
    const maxRetries = 2;

    while (
      !decision.startsWith('ALLOW') &&
      !decision.startsWith('WARN:') &&
      !decision.startsWith('BLOCK:') &&
      retries < maxRetries
    ) {
      retries++;

      const retryResponse = await anthropic.messages.create({
        model: getModelId('sonnet'),
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Invalid format: "${decision}". Reply with exactly: ALLOW, WARN: <reason>, or BLOCK: <reason>`
        }]
      });

      decision = (retryResponse.content[0] as { type: 'text'; text: string }).text.trim();
    }

    if (decision.startsWith('BLOCK:')) {
      const reason = decision.replace('BLOCK: ', '');

      await logToHomeAssistant({
        agent: 'intent-validate',
        level: 'decision',
        problem: `${action.toolName}: ${JSON.stringify(action.toolInput).substring(0, 100)}`,
        answer: `BLOCKED: ${reason}`
      });

      return {
        decision: 'BLOCK',
        reason
      };
    }

    if (decision.startsWith('WARN:')) {
      const reason = decision.replace('WARN: ', '');

      await logToHomeAssistant({
        agent: 'intent-validate',
        level: 'decision',
        problem: `${action.toolName}: ${JSON.stringify(action.toolInput).substring(0, 100)}`,
        answer: `WARNED: ${reason}`
      });

      return {
        decision: 'WARN',
        reason
      };
    }

    await logToHomeAssistant({
      agent: 'intent-validate',
      level: 'decision',
      problem: `${action.toolName}: ${JSON.stringify(action.toolInput).substring(0, 100)}`,
      answer: 'ALLOWED'
    });

    return { decision: 'ALLOW' };

  } catch (error) {
    // On error, fail open (allow) to avoid blocking user
    await logToHomeAssistant({
      agent: 'intent-validate',
      level: 'error',
      problem: 'Validation error',
      answer: String(error)
    });

    return {
      decision: 'ALLOW',
      reason: 'Validation error - defaulted to allow'
    };
  }
}
