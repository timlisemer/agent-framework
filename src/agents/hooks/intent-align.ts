/**
 * Intent Alignment Agent - Tool Call Alignment Check
 *
 * This agent validates that the AI's tool call or stop response
 * aligns with what the user actually requested. It catches scenarios where
 * the AI ignores user questions or does something unrelated to the request.
 *
 * ## FLOW
 *
 * 1. Read transcript to get last user message and any AI acknowledgment
 * 2. Run sonnet agent to check alignment
 * 3. Retry if format is invalid
 * 4. Return OK or BLOCK with reason
 *
 * ## KEY SCENARIOS DETECTED
 *
 * - User asks question, AI does tool call instead of answering
 * - User requests X, AI does Y (unrelated action)
 * - User says stop/explain, AI continues with tools
 * - AI acknowledged X but then did Y
 *
 * ## ACKNOWLEDGMENT HANDLING
 *
 * The "possible but not required thought/ack message" is handled by:
 * - Extracting any assistant text AFTER the last user message
 * - Passing it as context to the agent
 * - Agent verifies the tool matches both user request AND acknowledgment
 *
 * @module intent-align
 */

import { getModelId, type CheckResult, type StopCheckResult } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { FIRST_RESPONSE_INTENT_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { readTranscriptExact } from "../../utils/transcript.js";
import {
  FIRST_RESPONSE_INTENT_COUNTS,
  FIRST_RESPONSE_STOP_COUNTS,
} from "../../utils/transcript-presets.js";

// Re-export CheckResult as IntentAlignmentResult for backwards compatibility
export type IntentAlignmentResult = CheckResult;

/**
 * Check if the AI's tool call aligns with the user's request.
 *
 * Note: The "first tool call" gating is now handled by rewind-cache.ts.
 * This function always runs the full alignment check when called.
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @param transcriptPath - Path to the transcript file
 * @returns Check result with approval status and optional reason
 *
 * @example
 * ```typescript
 * const result = await checkIntentAlignment(
 *   'Edit',
 *   { file_path: 'src/auth.ts', ... },
 *   transcriptPath
 * );
 * if (!result.approved) {
 *   // Block: AI's action doesn't match user request
 * }
 * ```
 */
export async function checkIntentAlignment(
  toolName: string,
  toolInput: unknown,
  transcriptPath: string
): Promise<IntentAlignmentResult> {
  // Read transcript to get context
  const result = await readTranscriptExact(
    transcriptPath,
    FIRST_RESPONSE_INTENT_COUNTS
  );

  if (result.user.length === 0) {
    // No user message found - skip check
    return { approved: true };
  }

  // Get last user message
  const lastUserMessage = result.user[result.user.length - 1];
  const lastUserIndex = lastUserMessage.index;
  const userRequest = lastUserMessage.content;

  // Get assistant messages AFTER the last user message (acknowledgments)
  const assistantAfterUser = result.assistant.filter(
    (msg) => msg.index > lastUserIndex
  );

  // Combine any acknowledgment text
  const ackText = assistantAfterUser.map((m) => m.content).join("\n").trim();

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput).slice(0, 300)}`;

  // Format recent tool results for context
  const toolResultsText =
    result.toolResult.length > 0
      ? `\nRECENT TOOL RESULTS:\n${result.toolResult
          .map(
            (r) =>
              `- ${r.content.slice(0, 300)}${r.content.length > 300 ? "..." : ""}`
          )
          .join("\n")}\n`
      : "";

  // Build context for the agent
  const context = `USER MESSAGE:
${userRequest}

${ackText ? `AI ACKNOWLEDGMENT (text before this tool call):\n${ackText}\n` : ""}TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput, null, 2).slice(0, 500)}
${toolResultsText}`;

  // Run alignment check via unified runner
  const initialResponse = await runAgent(
    { ...FIRST_RESPONSE_INTENT_AGENT },
    {
      prompt: "Check if this tool call aligns with the user's request.",
      context,
    }
  );

  // Retry if format is invalid (must start with OK or BLOCK:)
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId(FIRST_RESPONSE_INTENT_AGENT.tier),
    initialResponse,
    toolDescription,
    {
      maxRetries: 1,
      formatValidator: (text) => startsWithAny(text, ["OK", "BLOCK:"]),
      formatReminder: "Reply with EXACTLY: OK or BLOCK: <reason>",
    }
  );

  if (decision.startsWith("OK")) {
    logToHomeAssistant({
      agent: "intent-align",
      level: "decision",
      problem: `Tool: ${toolName}`,
      answer: "OK - aligned with request",
    });
    return { approved: true };
  }

  // Extract block reason
  const reason = decision.startsWith("BLOCK: ")
    ? decision.substring(7).trim()
    : `Misaligned response: ${decision}`;

  logToHomeAssistant({
    agent: "intent-align",
    level: "decision",
    problem: `Tool: ${toolName}`,
    answer: `BLOCKED: ${reason}`,
  });

  return {
    approved: false,
    reason,
  };
}

// Re-export StopCheckResult as StopIntentResult for backwards compatibility
export type StopIntentResult = StopCheckResult;

/**
 * Use AI to classify a stop response as either an intermediate question,
 * plan approval request, or OK (legitimate).
 */
async function classifyStopResponse(
  userText: string,
  assistantText: string
): Promise<"INTERMEDIATE_QUESTION" | "PLAN_APPROVAL" | "OK"> {
  const context = `USER MESSAGE:
${userText}

ASSISTANT RESPONSE:
${assistantText}`;

  const systemPrompt = `You classify AI assistant responses that end with questions.

INTERMEDIATE_QUESTION - Use when:
- AI asks a clarifying question about implementation details
- AI confirms a specific technical choice before proceeding
- AI asks about behavior/correctness of something specific
- AI seeks confirmation on ONE specific aspect, not the whole plan
- Question is about code, output, or a specific step

Examples: "Does this output format look correct?", "Should I use async here?", "Is the behavior identical?"

PLAN_APPROVAL - Use when:
- AI has written a complete plan and asks for overall approval
- AI asks "ready to implement?" or "shall I start coding?"
- AI is in plan mode presenting a finished plan for sign-off
- AI explicitly says "here's my plan" or "here's what I'll do"

Examples: "Here's my plan. Ready to proceed?", "Does this plan look good?"

OK - Use when:
- AI makes a rhetorical statement (not expecting answer)
- Response is appropriate completion
- User already approved what AI is asking about

Reply with EXACTLY one of: INTERMEDIATE_QUESTION, PLAN_APPROVAL, or OK`;

  const response = await runAgent(
    {
      name: "stop-classify",
      tier: "haiku",
      mode: "direct",
      maxTokens: 50,
      systemPrompt,
    },
    { prompt: "Classify this response.", context }
  );

  const trimmed = response.trim().toUpperCase();
  if (trimmed.includes("PLAN_APPROVAL")) return "PLAN_APPROVAL";
  if (trimmed.includes("INTERMEDIATE_QUESTION")) return "INTERMEDIATE_QUESTION";
  return "OK";
}

// Patterns indicating AI is asking plain text questions (should use AskUserQuestion)
const PLAIN_TEXT_QUESTION_PATTERNS = [
  /would you like\b/i,
  /should I\b/i,
  /do you want\b/i,
  /do you prefer\b/i,
  /shall I\b/i,
  /can I\b/i,
  /may I\b/i,
  /let me know if\b/i,
  /what would you prefer/i,
];

// Patterns indicating AI is asking for plan approval in plain text (should use ExitPlanMode)
const PLAN_APPROVAL_PATTERNS = [
  /does this (?:plan |approach )?(?:look|sound) (?:good|ok|right)/i,
  /(?:ready to )?proceed with this/i,
  /(?:can|shall) I (?:proceed|continue|start)/i,
  /approve this (?:plan|approach)/i,
  /continue with (?:this|the) (?:plan|approach|implementation)/i,
];

/**
 * Strip quoted content from text to avoid false positives on quoted questions.
 */
function stripQuotedContent(text: string): string {
  return text
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/`[^`]*`/g, "");
}

/**
 * Extract the main question from user text (for error messages).
 */
function extractUserQuestion(text: string): string | null {
  const stripped = stripQuotedContent(text);
  const sentences = stripped.split(/[.!]\s+/);

  for (const sentence of sentences) {
    if (sentence.includes("?")) {
      return sentence.trim();
    }
  }

  // Check for question words without ?
  const questionMatch = stripped.match(
    /\b(what|why|how|where|when|which|who|can you|could you|would you)[^.!?]+/i
  );
  if (questionMatch) {
    return questionMatch[0].trim();
  }

  return null;
}

/**
 * Check if assistant response ends with a question or contains question patterns.
 */
function hasPlainTextQuestion(assistantText: string): {
  detected: boolean;
  type?: "question" | "plan_approval";
} {
  const trimmed = assistantText.trim();

  // Check for plan approval patterns first (more specific)
  for (const pattern of PLAN_APPROVAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { detected: true, type: "plan_approval" };
    }
  }

  // Check for general question patterns
  for (const pattern of PLAIN_TEXT_QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { detected: true, type: "question" };
    }
  }

  // Check if response ends with a question mark (common pattern)
  if (trimmed.endsWith("?")) {
    // Exclude rhetorical questions or self-directed questions
    const lastSentence = trimmed.split(/[.!]\s+/).pop() || "";
    if (
      !lastSentence.match(/^(?:why|how) (?:does|is|would) (?:this|that)/i) &&
      !lastSentence.match(/^(?:I wonder|wondering)/i)
    ) {
      return { detected: true, type: "question" };
    }
  }

  return { detected: false };
}

/**
 * Check if the AI's stop (text-only response) is appropriate.
 *
 * This catches scenarios where the AI:
 * - Uses plain text questions instead of AskUserQuestion tool
 * - Asks for plan approval in text instead of ExitPlanMode tool
 * - Doesn't answer the user's question
 *
 * @param transcriptPath - Path to the transcript file
 * @returns Check result with approval status, reason, and optional system message
 */
export async function checkStopIntentAlignment(
  transcriptPath: string
): Promise<StopIntentResult> {
  const result = await readTranscriptExact(
    transcriptPath,
    FIRST_RESPONSE_STOP_COUNTS
  );

  if (result.user.length === 0 || result.assistant.length === 0) {
    return { approved: true };
  }

  const lastUserMessage = result.user[result.user.length - 1];
  const lastAssistantMessage = result.assistant[result.assistant.length - 1];

  const userText = lastUserMessage.content;
  const assistantText = lastAssistantMessage.content;

  // Only check if assistant message is AFTER user message
  if (lastAssistantMessage.index <= lastUserMessage.index) {
    return { approved: true };
  }

  // Check 1: Plain text questions - use AI to classify
  const questionCheck = hasPlainTextQuestion(assistantText);
  if (questionCheck.detected) {
    // Use AI to determine if this is an intermediate question or plan approval
    const classification = await classifyStopResponse(userText, assistantText);

    if (classification === "PLAN_APPROVAL") {
      return {
        approved: false,
        reason: "Plain text plan approval detected",
        systemMessage:
          "Do not ask for plan approval in plain text. Use the ExitPlanMode tool to present the plan with structured approval options.",
      };
    } else if (classification === "INTERMEDIATE_QUESTION") {
      return {
        approved: false,
        reason: "Plain text question detected",
        systemMessage:
          "Do not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.",
      };
    }
    // classification === "OK" - allow it
  }

  // Check 2: User asked a question that wasn't addressed
  const userQuestion = extractUserQuestion(userText);

  if (userQuestion) {
    // Check if assistant response is very short (might not have answered)
    const strippedAssistant = stripQuotedContent(assistantText);

    // If assistant response is very short or doesn't seem to address the question
    if (strippedAssistant.length < 50) {
      // Check if it's just an acknowledgment without substance
      if (/^(?:I'll|Let me|Sure|OK|Okay|Got it|Understood)/.test(assistantText)) {
        return {
          approved: false,
          reason: "User question not answered",
          systemMessage: `You didn't answer the user's question: "${userQuestion}"\nPlease respond to what they asked.`,
        };
      }
    }
  }

  // Check 3: AI stopped without clear reason (very short response without action)
  const trimmedAssistant = assistantText.trim();
  if (
    trimmedAssistant.length < 30 &&
    !trimmedAssistant.match(/(?:done|completed|finished|ready)/i)
  ) {
    // Very short response that doesn't indicate completion
    return {
      approved: false,
      reason: "AI stopped without clear reason",
      systemMessage:
        "If you're unsure how to proceed, please explain what's blocking you so the user can help.",
    };
  }

  return { approved: true };
}
