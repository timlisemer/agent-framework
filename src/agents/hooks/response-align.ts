/**
 * Response Alignment Agent - Unified Response Validation
 *
 * This agent validates that the AI's response (tool call or stop) aligns with
 * what the user actually requested. It catches scenarios where the AI ignores
 * user questions, asks clarifications then continues anyway, or does something
 * unrelated to the request.
 *
 * ## FLOW
 *
 * 1. Read transcript to get last user message and any AI acknowledgment
 * 2. Check for preamble violations (AI asked question/clarification then continued)
 * 3. Run sonnet agent to check alignment
 * 4. Retry if format is invalid
 * 5. Return OK or BLOCK with reason
 *
 * ## KEY SCENARIOS DETECTED
 *
 * - AI asked clarification then continued with tools (preamble violation)
 * - User asks question, AI does tool call instead of answering
 * - User requests X, AI does Y (unrelated action)
 * - User says stop/explain, AI continues with tools
 * - AI acknowledged X but then did Y
 *
 * ## PREAMBLE HANDLING
 *
 * The AI acknowledgment text is checked for clarification patterns:
 * - "I need to clarify" / "Let me clarify"
 * - "Before I proceed" / "Just to confirm"
 * - Questions directed at the user
 *
 * If detected, the LLM decides if it's a genuine violation or rhetorical.
 *
 * @module response-align
 */

import { getModelId, MODEL_TIERS, type CheckResult, type StopCheckResult, type ModelTier } from "../../types.js";
import { runAgent, type AgentExecutionResult } from "../../utils/agent-runner.js";
import { RESPONSE_ALIGN_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { readTranscriptExact } from "../../utils/transcript.js";
import {
  INTENT_ALIGNMENT_COUNTS,
  FIRST_RESPONSE_STOP_COUNTS,
} from "../../utils/transcript-presets.js";

// Re-export CheckResult as ResponseAlignmentResult for backwards compatibility
export type ResponseAlignmentResult = CheckResult;

// Legacy alias for backwards compatibility
export type IntentAlignmentResult = CheckResult;

// Patterns indicating AI is asking a question/clarification that should wait for user response
const PREAMBLE_CONCERN_PATTERNS = [
  /I need to clarify/i,
  /let me clarify/i,
  /to clarify/i,
  /before I proceed/i,
  /before we continue/i,
  /just to confirm/i,
  /to make sure/i,
  /I'm not sure if/i,
  /I'm uncertain/i,
];

/**
 * Check if the AI acknowledgment contains potential preamble violations.
 * Returns true if the LLM should be alerted to check this.
 */
function hasPreambleConcern(ackText: string): boolean {
  if (!ackText) return false;

  // Check for explicit clarification patterns
  for (const pattern of PREAMBLE_CONCERN_PATTERNS) {
    if (pattern.test(ackText)) {
      return true;
    }
  }

  // Check for direct questions to user (ends with ? and seems directed at user)
  const sentences = ackText.split(/[.!]\s*/);
  for (const sentence of sentences) {
    if (sentence.trim().endsWith("?")) {
      // Skip rhetorical/self-directed questions
      if (!/^(?:I wonder|wondering|why (?:does|is|would) (?:this|that))/i.test(sentence)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Check if the AI's tool call aligns with the user's request.
 *
 * This function validates:
 * 1. Preamble violations - AI asked clarification then continued anyway
 * 2. Intent alignment - Tool call matches user's request
 *
 * Note: The "first tool call" gating is now handled by rewind-cache.ts.
 * This function always runs the full alignment check when called.
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @param transcriptPath - Path to the transcript file
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Check result with approval status and optional reason
 *
 * @example
 * ```typescript
 * const result = await checkResponseAlignment(
 *   'Edit',
 *   { file_path: 'src/auth.ts', ... },
 *   transcriptPath,
 *   cwd,
 *   'PreToolUse'
 * );
 * if (!result.approved) {
 *   // Block: AI's action doesn't match user request
 * }
 * ```
 */
export async function checkResponseAlignment(
  toolName: string,
  toolInput: unknown,
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<ResponseAlignmentResult> {
  // Skip response alignment checks for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    return { approved: true };
  }

  // Read transcript to get context
  const transcriptResult = await readTranscriptExact(
    transcriptPath,
    INTENT_ALIGNMENT_COUNTS
  );

  if (transcriptResult.user.length === 0) {
    // No user message found - skip check
    return { approved: true };
  }

  // Get last user message
  const lastUserMessage = transcriptResult.user[transcriptResult.user.length - 1];
  const lastUserIndex = lastUserMessage.index;
  const userRequest = lastUserMessage.content;

  // Get assistant messages AFTER the last user message (acknowledgments)
  const assistantAfterUser = transcriptResult.assistant.filter(
    (msg) => msg.index > lastUserIndex
  );

  // Combine any acknowledgment text
  const ackText = assistantAfterUser.map((m) => m.content).join("\n").trim();

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput).slice(0, 300)}`;

  // Format recent tool results for context
  const toolResultsText =
    transcriptResult.toolResult.length > 0
      ? `\nRECENT TOOL RESULTS:\n${transcriptResult.toolResult
          .map(
            (r) =>
              `- ${r.content.slice(0, 300)}${r.content.length > 300 ? "..." : ""}`
          )
          .join("\n")}\n`
      : "";

  // Check for preamble concerns and add to context if detected
  const preambleConcern = hasPreambleConcern(ackText);
  const preambleSection = preambleConcern
    ? `\n⚠️ PREAMBLE CONCERN: The AI acknowledgment appears to contain a question or clarification directed at the user. Check if the AI should have waited for user response before proceeding with this tool call.\n`
    : "";

  // Build context for the agent
  const context = `USER MESSAGE:
${userRequest}

${ackText ? `AI ACKNOWLEDGMENT (text before this tool call):\n${ackText}\n` : ""}${preambleSection}TOOL CALL:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput, null, 2).slice(0, 500)}
${toolResultsText}`;

  // Run alignment check via unified runner
  const result = await runAgent(
    { ...RESPONSE_ALIGN_AGENT },
    {
      prompt: "Check if this tool call aligns with the user's request.",
      context,
    }
  );

  // Retry if format is invalid (must start with OK or BLOCK:)
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId(RESPONSE_ALIGN_AGENT.tier),
    result.output,
    toolDescription,
    {
      maxRetries: 1,
      formatValidator: (text) => startsWithAny(text, ["OK", "BLOCK:"]),
      formatReminder: "Reply with EXACTLY: OK or BLOCK: <reason>",
    }
  );

  if (decision.startsWith("OK")) {
    logApprove(result, "response-align", hookName, toolName, workingDir, "direct", "llm", "Aligned with request");
    return { approved: true };
  }

  // Extract block reason
  const reason = decision.startsWith("BLOCK: ")
    ? decision.substring(7).trim()
    : `Misaligned response: ${decision}`;

  logDeny(result, "response-align", hookName, toolName, workingDir, "llm", reason);

  return {
    approved: false,
    reason,
  };
}

// Legacy alias for backwards compatibility
export const checkIntentAlignment = checkResponseAlignment;

// Re-export StopCheckResult as StopResponseResult for backwards compatibility
export type StopResponseResult = StopCheckResult;

// Legacy alias
export type StopIntentResult = StopCheckResult;

/**
 * Use AI to classify a stop response as either an intermediate question,
 * plan approval request, or OK (legitimate).
 */
async function classifyStopResponse(
  userText: string,
  assistantText: string,
  workingDir: string
): Promise<{ classification: "QUESTION" | "PLAN_APPROVAL" | "OK"; latencyMs: number; modelTier: ModelTier; success: boolean; errorCount: number }> {
  const context = `USER MESSAGE:
${userText}

ASSISTANT RESPONSE:
${assistantText}`;

  const systemPrompt = `You classify AI assistant responses that contain questions.

PLAN_APPROVAL - ONLY use when ALL of these are true:
- AI has laid out a DETAILED multi-step implementation plan
- AI explicitly uses words like "plan", "approach", "strategy", "implementation"
- AI asks for approval BEFORE starting any work
- This is about FUTURE work, not recovering from a failure

Examples of PLAN_APPROVAL:
- "Here's my plan: 1. Create the component 2. Add tests 3. Update docs. Ready to proceed?"
- "I'll approach this by first refactoring X, then adding Y. Does this look good?"

NOT PLAN_APPROVAL (these are QUESTION):
- "Would you like me to: 1. Fix X 2. Retry Y" (offering options, not a detailed plan)
- "The commit failed. Should I update the README and try again?" (error recovery)
- "Want me to push now?" (next action question)

QUESTION - Use when:
- AI asks about next action to take
- AI offers simple options or choices
- AI asks for clarification
- AI asks follow-up after a failure/error/block
- AI uses "Would you like me to" with simple options

Examples: "Should I commit?", "Want me to fix this?", "Would you like me to retry?"

OK - Use when:
- Not actually a question (rhetorical, self-directed)

Reply with EXACTLY one of: PLAN_APPROVAL, QUESTION, or OK`;

  const response = await runAgent(
    {
      name: "response-align-stop",
      tier: MODEL_TIERS.HAIKU,
      mode: "direct",
      maxTokens: 50,
      systemPrompt,
      workingDir,
    },
    { prompt: "Classify this response.", context }
  );

  const trimmed = response.output.trim().toUpperCase();
  let classification: "QUESTION" | "PLAN_APPROVAL" | "OK";
  if (trimmed.includes("PLAN_APPROVAL")) {
    classification = "PLAN_APPROVAL";
  } else if (trimmed.includes("QUESTION")) {
    classification = "QUESTION";
  } else {
    classification = "OK";
  }

  return {
    classification,
    latencyMs: response.latencyMs,
    modelTier: response.modelTier,
    success: response.success,
    errorCount: response.errorCount,
  };
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
 * Check if context indicates this is an operational follow-up, not plan approval.
 * Returns true if we should skip PLAN_APPROVAL classification.
 */
function isOperationalContext(userText: string, assistantText: string): boolean {
  // User ran a command - any follow-up is operational
  if (userText.trim().startsWith("/")) return true;

  // AI mentions failure/error/decline - this is error recovery, not planning
  const errorPatterns = [
    /(?:was |been |got )?(?:declined|rejected|failed|blocked)/i,
    /(?:error|issue|problem) (?:occurred|detected|found)/i,
    /could not|cannot|couldn't/i,
  ];
  if (errorPatterns.some((p) => p.test(assistantText))) return true;

  return false;
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
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Check result with approval status, reason, and optional system message
 */
export async function checkStopResponseAlignment(
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<StopResponseResult> {
  // Skip stop response checks for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    return { approved: true };
  }

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
    // Skip PLAN_APPROVAL if this is clearly operational context
    if (isOperationalContext(userText, assistantText)) {
      return {
        approved: false,
        reason: "Plain text question detected",
        systemMessage:
          "Do not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.",
      };
    }

    // Use AI to determine if this is an intermediate question or plan approval
    const classifyResult = await classifyStopResponse(userText, assistantText, workingDir);

    // Build AgentExecutionResult for logging
    const classifyAgentResult: AgentExecutionResult = {
      output: classifyResult.classification,
      latencyMs: classifyResult.latencyMs,
      modelTier: classifyResult.modelTier,
      modelName: getModelId(classifyResult.modelTier),
      success: classifyResult.success,
      errorCount: classifyResult.errorCount,
    };

    if (classifyResult.classification === "PLAN_APPROVAL") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, "llm", "Plain text plan approval detected");
      return {
        approved: false,
        reason: "Plain text plan approval detected",
        systemMessage:
          "Do not ask for plan approval in plain text. Write your plan to the plan file, then exit plan mode using the ExitPlanMode tool.",
      };
    } else if (classifyResult.classification === "QUESTION") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, "llm", "Plain text question detected");
      return {
        approved: false,
        reason: "Plain text question detected",
        systemMessage:
          "Do not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.",
      };
    }
    // classification === "OK" - allow it
    logApprove(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, "direct", "llm", "Legitimate stop response");
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

// Legacy alias for backwards compatibility
export const checkStopIntentAlignment = checkStopResponseAlignment;
