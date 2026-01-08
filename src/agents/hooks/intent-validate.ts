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
  EXECUTION_TYPES,
  type OffTopicCheckResult,
  type ConversationContext,
  type UserMessage,
  type AssistantMessage,
} from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { INTENT_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { readTranscriptExact } from "../../utils/transcript.js";
import { OFF_TOPIC_COUNTS } from "../../utils/transcript-presets.js";

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
        const role = userIndices.has(msg.messageIndex) ? "USER" : "ASSISTANT";
        return `[${role}]: ${msg.text}`;
      })
      .join("\n\n---\n\n");

    return {
      userMessages,
      assistantMessages,
      conversationSummary,
      lastAssistantMessage: lastAssistantMessage?.text || "",
    };
  } catch {
    return {
      userMessages: [],
      assistantMessages: [],
      conversationSummary: "",
      lastAssistantMessage: "",
    };
  }
}

/**
 * Check if AI has gone off-topic in its response.
 *
 * @param transcriptPath - Path to the transcript file
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Check result with optional intervention feedback
 *
 * @example
 * ```typescript
 * const result = await checkForOffTopic(transcriptPath, cwd, "Stop");
 * if (result.decision === 'INTERVENE') {
 *   console.log('Off-topic:', result.feedback);
 * }
 * ```
 */
export async function checkForOffTopic(
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<OffTopicCheckResult> {
  // Skip off-topic checks for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("off-topic-check", hookName, "StopResponse", workingDir, "Subagent skip");
    return { decision: "OK" };
  }

  const context = await extractConversationContext(transcriptPath);

  // No conversation yet - nothing to check
  if (context.userMessages.length === 0 || !context.lastAssistantMessage) {
    logFastPathApproval("off-topic-check", hookName, "StopResponse", workingDir, "No conversation yet");
    return {
      decision: "OK",
    };
  }

  try {
    // Run off-topic check via unified runner
    const result = await runAgent(
      { ...INTENT_VALIDATE_AGENT },
      {
        prompt:
          "Check if the assistant has gone off-topic or asked something already answered.",
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
      getModelId(INTENT_VALIDATE_AGENT.tier),
      result.output,
      "Intent validation for assistant response",
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ["OK", "INTERVENE:"]),
        formatReminder: "Reply with exactly: OK or INTERVENE: <feedback>",
        maxTokens: 150,
      }
    );

    if (decision.startsWith("INTERVENE:")) {
      const feedback = decision.replace("INTERVENE:", "").trim();

      logDeny(result, "off-topic-check", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, feedback);

      return {
        decision: "INTERVENE",
        feedback,
      };
    }

    logApprove(result, "off-topic-check", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "On-topic");

    return { decision: "OK" };
  } catch {
    // On error, fail open (don't intervene)
    logFastPathApproval("off-topic-check", hookName, "StopResponse", workingDir, "Error path - fail open");
    return {
      decision: "OK",
      feedback: "Check error - skipped",
    };
  }
}
