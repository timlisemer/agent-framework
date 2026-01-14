/**
 * Question Validate Agent - AskUserQuestion Guardian
 *
 * This agent validates AskUserQuestion tool calls before showing to user.
 * It catches inappropriate questions that would trap or confuse the user.
 *
 * ## FLOW
 *
 * 1. Skip if subagent (Task-spawned agents)
 * 2. Parse questions from tool input
 * 3. Run agent to check if questions are appropriate
 * 4. Return ALLOW or BLOCK with feedback
 *
 * ## BLOCK DETECTION
 *
 * Blocks:
 * - Questions about content user hasn't seen (e.g., plan not displayed)
 * - Questions user already answered earlier (~90% confidence)
 * - Workflow violations (asking about implementation before plan approved)
 *
 * Allows:
 * - On-topic clarifications for genuine ambiguity
 * - Questions where user has context to answer
 *
 * @module question-validate
 */

import { getModelId, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { QUESTION_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval, logAgentStarted } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";

/**
 * AskUserQuestion tool input structure.
 */
interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
}

/**
 * Format questions for the agent prompt.
 */
function formatQuestions(input: AskUserQuestionInput): string {
  return input.questions
    .map((q, i) => {
      const options = q.options
        .map((opt) => `  - ${opt.label}: ${opt.description}`)
        .join("\n");
      return `Question ${i + 1} [${q.header}]: ${q.question}\nOptions:\n${options}`;
    })
    .join("\n\n");
}

/**
 * Validate that AskUserQuestion is appropriate before showing to user.
 *
 * @param toolInput - The AskUserQuestion tool input with questions
 * @param conversationContext - Formatted conversation context (user + assistant + tool results)
 * @param transcriptPath - Path to the transcript file (for subagent detection)
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Approval result with optional feedback
 *
 * @example
 * ```typescript
 * const result = await checkQuestionValidity(toolInput, context, transcriptPath, cwd, "PreToolUse");
 * if (!result.approved) {
 *   console.log('Question blocked:', result.reason);
 * }
 * ```
 */
export async function checkQuestionValidity(
  toolInput: unknown,
  conversationContext: string,
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
  const toolName = "AskUserQuestion";

  // Skip validation for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("question-validate", hookName, toolName, workingDir, "Subagent skip");
    return { approved: true };
  }

  // Parse and validate tool input
  const input = toolInput as AskUserQuestionInput;
  if (!input?.questions || !Array.isArray(input.questions) || input.questions.length === 0) {
    logFastPathApproval("question-validate", hookName, toolName, workingDir, "No questions to validate");
    return { approved: true };
  }

  // No conversation context - allow (first interaction)
  if (!conversationContext.trim()) {
    logFastPathApproval("question-validate", hookName, toolName, workingDir, "No conversation context");
    return { approved: true };
  }

  try {
    // Format questions for the agent
    const formattedQuestions = formatQuestions(input);

    // Mark agent as running in statusline
    logAgentStarted("question-validate", "AskUserQuestion");

    // Run question validation via unified runner
    const result = await runAgent(
      { ...QUESTION_VALIDATE_AGENT },
      {
        prompt: "Check if these questions are appropriate to show to the user.",
        context: `QUESTIONS:\n${formattedQuestions}\n\nCONVERSATION AND TOOL HISTORY:\n${conversationContext}`,
      }
    );

    // Retry if format is invalid
    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId(QUESTION_VALIDATE_AGENT.tier),
      result.output,
      `Question validation for: ${formattedQuestions.substring(0, 100)}...`,
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ["ALLOW", "BLOCK:"]),
        formatReminder: "Reply with exactly: ALLOW or BLOCK: <feedback>",
        maxTokens: 200,
      }
    );

    if (decision.startsWith("BLOCK:")) {
      const feedback = decision.replace("BLOCK:", "").trim();

      logDeny(result, "question-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, feedback);

      return {
        approved: false,
        reason: feedback,
      };
    }

    logApprove(result, "question-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, "Questions appropriate");

    return { approved: true };
  } catch {
    // On error, fail open (allow the question)
    logFastPathApproval("question-validate", hookName, toolName, workingDir, "Error path - fail open");
    return { approved: true };
  }
}
