/**
 * Intent Validate Agent - Off-Topic Detection
 *
 * This agent detects when an AI has gone off-track and is about to waste
 * the user's time with irrelevant questions or suggestions.
 *
 * ## FLOW
 *
 * 1. Extract conversation context from transcript
 * 2. Skip if no user messages or no assistant response
 * 3. Run unified agent to check alignment
 * 4. Retry if format is invalid
 * 5. Return OK or INTERVENE with feedback
 *
 * ## DETECTION TARGETS
 *
 * - Redundant questions (already answered)
 * - Off-topic questions (never mentioned)
 * - Irrelevant suggestions
 * - Misunderstood requests
 *
 * ## ALLOWED CASES
 *
 * - On-topic clarifications
 * - Relevant follow-ups
 * - Progress updates
 *
 * @module intent-validate
 */

import {
  getModelId,
  type OffTopicCheckResult,
  type ConversationContext,
  type UserMessage,
  type AssistantMessage,
} from '../../types.js';
import { runAgent } from '../../utils/agent-runner.js';
import { INTENT_VALIDATE_AGENT } from '../../utils/agent-configs.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';
import { readTranscriptExact } from '../../utils/transcript.js';
import { OFF_TOPIC_COUNTS } from '../../utils/transcript-presets.js';

/**
 * Extract conversation context from a transcript file.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns Structured conversation context
 */
export async function extractConversationContext(
  transcriptPath: string
): Promise<ConversationContext> {
  try {
    const result = await readTranscriptExact(transcriptPath, OFF_TOPIC_COUNTS);

    // Convert to UserMessage format (includes tool_result as user context)
    const userMessages: UserMessage[] = [
      ...result.user.map((msg) => ({
        text: msg.content,
        messageIndex: msg.index,
      })),
      ...result.toolResult.map((msg) => ({
        text: msg.content,
        messageIndex: msg.index,
      })),
    ].sort((a, b) => a.messageIndex - b.messageIndex);

    const assistantMessages: AssistantMessage[] = result.assistant.map((msg) => ({
      text: msg.content,
      messageIndex: msg.index,
    }));

    const lastAssistantMessage = assistantMessages[assistantMessages.length - 1];

    const allMessages = [...userMessages, ...assistantMessages.slice(0, -1)].sort(
      (a, b) => a.messageIndex - b.messageIndex
    );

    // Build set of user message indices for role lookup
    const userIndices = new Set(userMessages.map((u) => u.messageIndex));

    const conversationSummary = allMessages
      .map((msg) => {
        const role = userIndices.has(msg.messageIndex) ? 'USER' : 'ASSISTANT';
        return `[${role}]: ${msg.text}`;
      })
      .join('\n\n---\n\n');

    return {
      userMessages,
      assistantMessages,
      conversationSummary,
      lastAssistantMessage: lastAssistantMessage?.text || '',
    };
  } catch {
    return {
      userMessages: [],
      assistantMessages: [],
      conversationSummary: '',
      lastAssistantMessage: '',
    };
  }
}

/**
 * Check if AI has gone off-topic in its response.
 *
 * @param transcriptPath - Path to the transcript file
 * @returns Check result with optional intervention feedback
 *
 * @example
 * ```typescript
 * const result = await checkForOffTopic(transcriptPath);
 * if (result.decision === 'INTERVENE') {
 *   console.log('Off-topic:', result.feedback);
 * }
 * ```
 */
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
    // Run off-topic check via unified runner
    const initialResponse = await runAgent(
      { ...INTENT_VALIDATE_AGENT },
      {
        prompt:
          'Check if the assistant has gone off-topic or asked something already answered.',
        context: `CONVERSATION CONTEXT:
${context.conversationSummary}

---

ASSISTANT'S FINAL RESPONSE (waiting for user input):
${context.lastAssistantMessage}`,
      }
    );

    // Retry if format is invalid
    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId('haiku'),
      initialResponse,
      `Intent validation for assistant response`,
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ['OK', 'INTERVENE:']),
        formatReminder: 'Reply with exactly: OK or INTERVENE: <feedback>',
        maxTokens: 150,
      }
    );

    if (decision.startsWith('INTERVENE:')) {
      const feedback = decision.replace('INTERVENE:', '').trim();

      logToHomeAssistant({
        agent: 'off-topic-check',
        level: 'decision',
        problem: `Assistant stopped with: ${context.lastAssistantMessage.substring(0, 100)}...`,
        answer: `INTERVENE: ${feedback}`,
      });

      return {
        decision: 'INTERVENE',
        feedback,
      };
    }

    logToHomeAssistant({
      agent: 'off-topic-check',
      level: 'decision',
      problem: `Assistant stopped with: ${context.lastAssistantMessage.substring(0, 100)}...`,
      answer: 'OK',
    });

    return { decision: 'OK' };
  } catch (err) {
    // On issue, fail open (don't intervene)
    logToHomeAssistant({
      agent: 'off-topic-check',
      level: 'info',
      problem: 'Check issue',
      answer: String(err),
    });

    return {
      decision: 'OK',
      feedback: 'Check issue - skipped',
    };
  }
}
