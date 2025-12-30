import Anthropic from '@anthropic-ai/sdk';
import * as fs from 'fs';
import { getModelId, type OffTopicCheckResult, type ConversationContext, type UserMessage, type AssistantMessage } from '../types.js';
import { logToHomeAssistant } from '../utils/logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

const RECENT_MESSAGE_LIMIT = 30;

const SYSTEM_PROMPT = `You are a conversation-alignment detector. Your job is to catch when an AI assistant has gone off-track and is about to waste the user's time.

You will receive:
1. CONVERSATION CONTEXT: Recent user and assistant messages from the conversation
2. ASSISTANT'S FINAL RESPONSE: What the assistant just said (it has stopped and is waiting for user input)

Your task: Determine if the assistant is asking the user something irrelevant or already answered.

WHAT TO DETECT (→ INTERVENE):

1. REDUNDANT QUESTIONS - AI asks something already answered:
   - User said "the config is in /etc/myapp/config.yaml" earlier
   - AI now asks "Where is your configuration file located?"
   - This wastes the user's time - INTERVENE

2. OFF-TOPIC QUESTIONS - AI asks about something the user never mentioned:
   - User asked to "fix the login bug"
   - AI asks "Would you like me to refactor the database schema?"
   - User never mentioned database schema - INTERVENE

3. IRRELEVANT SUGGESTIONS - AI suggests something unrelated to user's goal:
   - User asked to "add dark mode to settings"
   - AI says "I notice you could improve performance by adding caching, should I do that?"
   - This is not what the user asked for - INTERVENE

4. MISUNDERSTOOD REQUESTS - AI is clearly doing something different than asked:
   - User asked to "update the tests"
   - AI says "I've finished redesigning the UI, what do you think?"
   - Complete disconnect from user's request - INTERVENE

WHEN IT'S FINE (→ OK):

1. ON-TOPIC CLARIFICATIONS - AI asks about genuine ambiguity in user's request:
   - User said "fix the bug" without specifying which one
   - AI asks "I see multiple issues, which one should I prioritize?"
   - Legitimate need for clarification - OK

2. RELEVANT FOLLOW-UPS - AI completed task and asks what's next:
   - User asked to "add the button"
   - AI says "Done! Should I also add the click handler?"
   - Related follow-up - OK

3. NECESSARY INFORMATION - AI needs info user hasn't provided yet:
   - User asked to "deploy to production"
   - AI asks "What's the production server address?"
   - User hasn't answered this yet - OK

4. PROGRESS UPDATES - AI reports what it did and awaits confirmation:
   - "I've made these changes, does this look correct?"
   - Normal workflow - OK

RESPONSE FORMAT:
Reply with EXACTLY one of:

OK
or
INTERVENE: <specific feedback to give the AI, addressing what it got wrong and redirecting it>

RULES:
- Consider ALL previous messages when checking if something was already answered
- The goal is to prevent the user from being bothered with irrelevant questions
- When in doubt, choose OK - only INTERVENE when there's a clear disconnect
- Your intervention message should be helpful and specific, guiding the AI back on track
- Keep intervention messages concise but actionable`;

export async function extractConversationContext(transcriptPath: string): Promise<ConversationContext> {
  try {
    const content = await fs.promises.readFile(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    const userMessages: UserMessage[] = [];
    const assistantMessages: AssistantMessage[] = [];

    lines.forEach((line, idx) => {
      try {
        const entry = JSON.parse(line);

        if (entry.message?.role === 'user') {
          let text = '';

          if (typeof entry.message.content === 'string') {
            text = entry.message.content;
          } else if (Array.isArray(entry.message.content)) {
            const textBlocks = entry.message.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text);

            const toolResults = entry.message.content
              .filter((block: any) => block.type === 'tool_result')
              .map((block: any) => {
                // tool_result content can be string or array
                if (typeof block.content === 'string') {
                  return block.content;
                } else if (Array.isArray(block.content)) {
                  return block.content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text)
                    .join(' ');
                }
                return '';
              });

            text = [...textBlocks, ...toolResults].join('\n');
          }

          if (text.trim()) {
            userMessages.push({
              text: text.trim(),
              messageIndex: idx
            });
          }
        }

        if (entry.message?.role === 'assistant') {
          let text = '';

          if (Array.isArray(entry.message.content)) {
            const textBlocks = entry.message.content
              .filter((block: any) => block.type === 'text')
              .map((block: any) => block.text);

            const toolResults = entry.message.content
              .filter((block: any) => block.type === 'tool_result')
              .map((block: any) => {
                // tool_result content can be string or array
                if (typeof block.content === 'string') {
                  return block.content;
                } else if (Array.isArray(block.content)) {
                  return block.content
                    .filter((c: any) => c.type === 'text')
                    .map((c: any) => c.text)
                    .join(' ');
                }
                return '';
              });

            text = [...textBlocks, ...toolResults].join('\n');
          }

          if (text.trim()) {
            assistantMessages.push({
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
    const recentUserMessages = userMessages.length > RECENT_MESSAGE_LIMIT
      ? userMessages.slice(-RECENT_MESSAGE_LIMIT)
      : userMessages;

    const recentAssistantMessages = assistantMessages.length > RECENT_MESSAGE_LIMIT
      ? assistantMessages.slice(-RECENT_MESSAGE_LIMIT)
      : assistantMessages;

    // Get the last assistant message (what the AI just said)
    const lastAssistantMessage = recentAssistantMessages[recentAssistantMessages.length - 1];

    // Build conversation summary (interleaved user and assistant messages)
    const allMessages = [...recentUserMessages, ...recentAssistantMessages.slice(0, -1)]
      .sort((a, b) => a.messageIndex - b.messageIndex);

    const conversationSummary = allMessages
      .map(msg => {
        const role = 'text' in msg ? 
          (recentUserMessages.includes(msg as UserMessage) ? 'USER' : 'ASSISTANT') : 
          'UNKNOWN';
        return `[${role}]: ${msg.text}`;
      })
      .join('\n\n---\n\n');

    return {
      userMessages: recentUserMessages,
      assistantMessages: recentAssistantMessages,
      conversationSummary,
      lastAssistantMessage: lastAssistantMessage?.text || ''
    };
  } catch (error) {
    // If transcript doesn't exist or is unreadable, return empty
    return {
      userMessages: [],
      assistantMessages: [],
      conversationSummary: '',
      lastAssistantMessage: ''
    };
  }
}

export async function checkForOffTopic(
  transcriptPath: string
): Promise<OffTopicCheckResult> {
  const context = await extractConversationContext(transcriptPath);

  // No conversation yet - nothing to check
  if (context.userMessages.length === 0 || !context.lastAssistantMessage) {
    return {
      decision: 'OK',
    };
  }

  try {
    const response = await anthropic.messages.create({
      model: getModelId('haiku'),
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `CONVERSATION CONTEXT:
${context.conversationSummary}

---

ASSISTANT'S FINAL RESPONSE (waiting for user input):
${context.lastAssistantMessage}

---

Is the assistant on track, or has it gone off-topic / asked something already answered?
Reply with: OK or INTERVENE: <feedback for the AI>`
      }],
      system: SYSTEM_PROMPT
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    let decision =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    // Retry logic for malformed responses
    let retries = 0;
    const maxRetries = 2;

    while (
      !decision.startsWith('OK') &&
      !decision.startsWith('INTERVENE:') &&
      retries < maxRetries
    ) {
      retries++;

      const retryResponse = await anthropic.messages.create({
        model: getModelId('haiku'),
        max_tokens: 150,
        messages: [{
          role: 'user',
          content: `Invalid format: "${decision}". Reply with exactly: OK or INTERVENE: <feedback>`
        }]
      });

      const retryTextBlock = retryResponse.content.find(
        (block) => block.type === 'text'
      );
      decision =
        retryTextBlock && 'text' in retryTextBlock
          ? retryTextBlock.text.trim()
          : '';
    }

    if (decision.startsWith('INTERVENE:')) {
      const feedback = decision.replace('INTERVENE:', '').trim();

      await logToHomeAssistant({
        agent: 'off-topic-check',
        level: 'decision',
        problem: `Assistant stopped with: ${context.lastAssistantMessage.substring(0, 100)}...`,
        answer: `INTERVENE: ${feedback}`
      });

      return {
        decision: 'INTERVENE',
        feedback
      };
    }

    await logToHomeAssistant({
      agent: 'off-topic-check',
      level: 'decision',
      problem: `Assistant stopped with: ${context.lastAssistantMessage.substring(0, 100)}...`,
      answer: 'OK'
    });

    return { decision: 'OK' };

  } catch (error) {
    // On error, fail open (don't intervene)
    await logToHomeAssistant({
      agent: 'off-topic-check',
      level: 'error',
      problem: 'Check error',
      answer: String(error)
    });

    return {
      decision: 'OK',
      feedback: 'Check error - skipped'
    };
  }
}
