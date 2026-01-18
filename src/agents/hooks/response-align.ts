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

import { getModelId, MODEL_TIERS, EXECUTION_TYPES, type CheckResult, type StopCheckResult, type ModelTier } from "../../types.js";
import { runAgent, type AgentExecutionResult } from "../../utils/agent-runner.js";
import { RESPONSE_ALIGN_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval, logFastPathDeny, logAgentStarted } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { readTranscriptExact, type TranscriptMessage } from "../../utils/transcript.js";
import {
  INTENT_ALIGNMENT_COUNTS,
  FIRST_RESPONSE_STOP_COUNTS,
} from "../../utils/transcript-presets.js";
import { detectUserDirectedQuestions } from "../../utils/content-patterns.js";

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
 * Find the most recent message by transcript index.
 * readTranscriptExact scans backwards, so array order doesn't match chronological order.
 */
function getMostRecentMessage(messages: TranscriptMessage[]): TranscriptMessage {
  return messages.reduce((latest, msg) =>
    msg.index > latest.index ? msg : latest
  );
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
    logFastPathApproval("response-align", hookName, toolName, workingDir, "Subagent skip");
    return { approved: true };
  }

  // Read transcript to get context
  const transcriptResult = await readTranscriptExact(
    transcriptPath,
    INTENT_ALIGNMENT_COUNTS
  );

  if (transcriptResult.user.length === 0) {
    // No user message found - skip check
    logFastPathApproval("response-align", hookName, toolName, workingDir, "No user message");
    return { approved: true };
  }

  // Check if user answered via AskUserQuestion tool (tool result with answer indicator)
  // This means user provided fresh input that supersedes any prior stop hook feedback
  const hasUserToolAnswer = transcriptResult.toolResult.some(
    (tr) => tr.content.includes("User answered") || tr.content.includes("answered Claude's questions") || tr.content.includes("→")
  );
  if (hasUserToolAnswer) {
    logFastPathApproval("response-align", hookName, toolName, workingDir, "Fresh AskUserQuestion answer");
    return { approved: true };
  }

  // Get most recent user message (highest index, not last in array)
  const lastUserMessage = getMostRecentMessage(transcriptResult.user);
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

  // Mark agent as running in statusline
  logAgentStarted("response-align", toolName);

  try {
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
      logApprove(result, "response-align", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, "Aligned with request");
      return { approved: true };
    }

    // Extract block reason
    const reason = decision.startsWith("BLOCK: ")
      ? decision.substring(7).trim()
      : `Misaligned response: ${decision}`;

    logDeny(result, "response-align", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, reason);

    return {
      approved: false,
      reason,
    };
  } catch {
    // On error, fail open and log completion to clear "running" status
    logFastPathApproval("response-align", hookName, toolName, workingDir, "Error path - fail open");
    return { approved: true };
  }
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
 *
 * @param questionHint - Optional regex-detected question patterns as a hint to the LLM
 */
async function classifyStopResponse(
  userText: string,
  assistantText: string,
  workingDir: string,
  stopHookError?: string,
  questionHint?: string[]
): Promise<{ classification: "QUESTION" | "PLAN_APPROVAL" | "IGNORED_ERROR" | "OK"; latencyMs: number; modelTier: ModelTier; success: boolean; errorCount: number; generationId?: string }> {
  const stopHookSection = stopHookError
    ? `\nPREVIOUS STOP HOOK ERROR:\n${stopHookError}\n`
    : "";

  // Add question hint section if regex detected potential questions
  const questionHintSection = questionHint && questionHint.length > 0
    ? `\n=== QUESTION PATTERNS DETECTED (REGEX) ===\nThe following patterns were detected and are LIKELY questions requiring user input:\n${questionHint.join("\n")}\n\nIMPORTANT: These patterns have HIGH precedence. Only classify as OK if you are CERTAIN the pattern is a false positive (e.g., relative clauses like "handle what is being said"). When in doubt, classify as QUESTION.\n=== END HINT ===\n`
    : "";

  const context = `USER MESSAGE:
${userText}
${stopHookSection}${questionHintSection}
ASSISTANT RESPONSE:
${assistantText}`;

  const systemPrompt = `You classify AI assistant responses.

IGNORED_ERROR - Use ONLY when:
- There is a PREVIOUS STOP HOOK ERROR in the context
- The error pointed out a REAL problem the AI should fix
- The AI's response does NOT address that problem

DO NOT use IGNORED_ERROR when:
- The AI already completed the task before the stop hook fired
- The AI is explaining the task is done (e.g., "Pushed successfully", "Changes complete")
- The stop hook error seems spurious (fired after successful completion)
- The AI acknowledges confusion about what the hook wants
- Examples: "The task is complete", "Done", "Pushed to remote" → OK, not IGNORED_ERROR

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

QUESTION - Use ONLY when the AI asks something that REQUIRES a decision from the user:
- AI presents clear options/choices (A or B, option 1 vs 2)
- AI asks for clarification needed to proceed
- AI asks yes/no about a SPECIFIC action ("Should I add error handling for this edge case?")
- AI offers alternatives after failure ("Should I retry with X or try Y instead?")

Examples that ARE QUESTION:
- "Should I use TypeScript or JavaScript?" (clear A/B choice)
- "Do you want me to: 1. Fix the bug 2. Add tests first?" (options)
- "The build failed. Should I fix the linting errors or skip them?" (decision needed)
- "Which approach do you prefer?" (requires user input)

OPTION PRESENTATION (always QUESTION):
When AI presents structured options in ANY of these formats, it is ALWAYS a QUESTION:
- "Option A: ... Option B: ..."
- "1. ... 2. ..." with preference question
- "A) ... B) ..."
- "Here are two approaches: ..."
This includes when followed by ANY question like "prefer?", "want?", "thoughts?"
Examples:
- "Option A: Use env vars. Option B: Use process ID. Which do you prefer?" → QUESTION
- "Here are two ways: 1. Simple approach 2. Complex approach. Which sounds better?" → QUESTION

NOT QUESTION (use OK instead):
- Open-ended "what's next": "Done! Do you have another topic?" "Anything else?" "What would you like to work on next?"
- Rhetorical: "Why would this fail?" (thinking aloud)
- Confirmation of completion: "Task complete. Need anything else?"
- Self-directed: "Let me check if this works..."
- Relative clauses: "handle what is being said", "debug what i am telling you"
- Embedded clauses: "the reason why it failed"

KEY TEST: Does the user need to make a SPECIFIC decision to proceed?
- If AI presents options/choices → QUESTION (even if phrased softly)
- If AI asks "what's next" after completing work → OK
When regex detected a pattern AND the response contains option presentation, default to QUESTION.

OK - Use when:
- Task completion with open-ended follow-up ("Done. Anything else?")
- Rhetorical or self-directed questions
- Relative clauses (question words used as pronouns)
- AI properly addressed a previous stop hook error

Reply with EXACTLY one of: IGNORED_ERROR, PLAN_APPROVAL, QUESTION, or OK`;

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
  let classification: "QUESTION" | "PLAN_APPROVAL" | "IGNORED_ERROR" | "OK";
  if (trimmed.includes("IGNORED_ERROR")) {
    classification = "IGNORED_ERROR";
  } else if (trimmed.includes("PLAN_APPROVAL")) {
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
    generationId: response.generationId,
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
 * Verify if regex-extracted text is actually a question using LLM.
 * This prevents false positives from relative clauses like "handle what is being said".
 */
async function verifyIsActualQuestion(
  extractedText: string,
  fullUserMessage: string,
  workingDir: string
): Promise<{ isQuestion: boolean; latencyMs: number }> {
  const startTime = Date.now();

  const systemPrompt = `You determine if extracted text is an actual question the user is asking.

ACTUAL QUESTIONS (user wants an answer):
- "What should I do next?" - direct question
- "How does this work?" - seeking explanation
- "Can you help with X?" - requesting assistance

NOT QUESTIONS (false positives):
- Relative clauses: "handle what is being said" - the "what" is a relative pronoun, not a question
- Embedded clauses: "debug what i am telling you" - subordinate clause, not asking anything
- Noun phrases: "the reason why it failed" - descriptive, not interrogative
- Mid-sentence question words: "I do not want you to handle what is being said" - statement with embedded clause

KEY TEST: Would the user expect a direct answer to this specific text? If the question word (what/why/how/etc) is embedded mid-sentence or follows a verb like "handle/debug/explain/understand", it's likely a relative clause, NOT a question.

Reply with EXACTLY: QUESTION or NOT_QUESTION`;

  const context = `FULL USER MESSAGE:
${fullUserMessage}

EXTRACTED TEXT (potential question):
${extractedText}

Is the extracted text an actual question the user wants answered?`;

  const response = await runAgent(
    {
      name: "verify-user-question",
      tier: MODEL_TIERS.HAIKU,
      mode: "direct",
      maxTokens: 20,
      systemPrompt,
      workingDir,
    },
    { prompt: "Is this an actual question?", context }
  );

  const trimmed = response.output.trim().toUpperCase();
  const isQuestion = trimmed.includes("QUESTION") && !trimmed.includes("NOT_QUESTION");

  return { isQuestion, latencyMs: Date.now() - startTime };
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
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Subagent skip");
    return { approved: true };
  }

  const result = await readTranscriptExact(
    transcriptPath,
    FIRST_RESPONSE_STOP_COUNTS
  );

  if (result.user.length === 0 || result.assistant.length === 0) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "No conversation");
    return { approved: true };
  }

  const lastUserMessage = getMostRecentMessage(result.user);
  const lastAssistantMessage = getMostRecentMessage(result.assistant);

  const userText = lastUserMessage.content;
  const assistantText = lastAssistantMessage.content;

  // Only check if assistant message is AFTER user message
  if (lastAssistantMessage.index <= lastUserMessage.index) {
    logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Message ordering skip");
    return { approved: true };
  }

  // Check for previous stop hook errors (used as hint for LLM)
  // Matches both old format "Error: Stop hook -" and new format "[AUTOGENERATED STOP HOOK FEEDBACK]"
  const stopHookErrorPattern = /Error: Stop hook -|Stop hook.*feedback|\[AUTOGENERATED STOP HOOK FEEDBACK\]/i;
  const stopHookError = result.user.find(m => stopHookErrorPattern.test(m.content));

  // Check 1: Plain text questions OR previous stop hook error - use AI to classify
  const questionCheck = hasPlainTextQuestion(assistantText);

  // Run regex-based question detection as a hint for the LLM
  // This provides deterministic pattern matching that the LLM can use to confirm
  const regexQuestionHints = detectUserDirectedQuestions(assistantText);

  const needsLLMCheck = questionCheck.detected || stopHookError || regexQuestionHints.length > 0;

  if (needsLLMCheck) {
    // Use AI to determine classification (pass stop hook error and question hints)
    const classifyResult = await classifyStopResponse(
      userText,
      assistantText,
      workingDir,
      stopHookError?.content,
      regexQuestionHints
    );

    // Build AgentExecutionResult for logging
    const classifyAgentResult: AgentExecutionResult = {
      output: classifyResult.classification,
      latencyMs: classifyResult.latencyMs,
      modelTier: classifyResult.modelTier,
      modelName: getModelId(classifyResult.modelTier),
      success: classifyResult.success,
      errorCount: classifyResult.errorCount,
      generationId: classifyResult.generationId,
    };

    if (classifyResult.classification === "IGNORED_ERROR") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Previous stop hook error ignored");
      return {
        approved: false,
        reason: "Previous stop hook error ignored",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nYou ignored the previous stop hook error. Address the feedback before continuing.",
      };
    } else if (classifyResult.classification === "PLAN_APPROVAL") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Plain text plan approval detected");
      return {
        approved: false,
        reason: "Plain text plan approval detected",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask for plan approval in plain text. Write your plan to the plan file, then exit plan mode using the ExitPlanMode tool.",
      };
    } else if (classifyResult.classification === "QUESTION") {
      logDeny(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Plain text question detected");
      return {
        approved: false,
        reason: "Plain text question detected",
        systemMessage:
          "[AUTOGENERATED STOP HOOK FEEDBACK]\nDo not ask questions in plain text. Use the AskUserQuestion tool to present structured options to the user.",
      };
    }
    // classification === "OK" - allow it
    logApprove(classifyAgentResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "Legitimate stop response");
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
        // Verify with LLM that the extracted text is actually a question
        // This prevents false positives from relative clauses like "handle what is being said"
        const verification = await verifyIsActualQuestion(userQuestion, userText, workingDir);

        if (verification.isQuestion) {
          // Log the denial with LLM-based verification info
          const syntheticResult: AgentExecutionResult = {
            output: "DENY",
            latencyMs: verification.latencyMs,
            modelTier: MODEL_TIERS.HAIKU,
            modelName: getModelId(MODEL_TIERS.HAIKU),
            success: true,
            errorCount: 0,
          };
          logDeny(syntheticResult, "response-align-stop", hookName, "StopResponse", workingDir, EXECUTION_TYPES.LLM, "User question not answered");
          return {
            approved: false,
            reason: "User question not answered",
            systemMessage: `[AUTOGENERATED STOP HOOK FEEDBACK]\nYou didn't answer the user's question: "${userQuestion}"\nPlease respond to what they asked.`,
          };
        }
      }
    }
  }

  // Check 3: AI stopped without clear reason (very short response without action)
  const trimmedAssistant = assistantText.trim();
  if (
    trimmedAssistant.length < 30 &&
    !trimmedAssistant.match(/(?:done|completed|finished|ready|pushed|committed|updated|added|removed|fixed|changed|success)/i)
  ) {
    // Skip if user ran a slash command (skill) - short responses are expected after /push, /commit, etc.
    const isSkillCompletion = userText.trim().startsWith("/");
    if (isSkillCompletion) {
      logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Skill completion");
      return { approved: true };
    }

    // Very short response that doesn't indicate completion
    logFastPathDeny("response-align-stop", hookName, "StopResponse", workingDir, "AI stopped without clear reason");
    return {
      approved: false,
      reason: "AI stopped without clear reason",
      systemMessage:
        "[AUTOGENERATED STOP HOOK FEEDBACK]\nIf you're unsure how to proceed, please explain what's blocking you so the user can help.",
    };
  }

  logFastPathApproval("response-align-stop", hookName, "StopResponse", workingDir, "Stop response aligned");
  return { approved: true };
}

// Legacy alias for backwards compatibility
export const checkStopIntentAlignment = checkStopResponseAlignment;
