/**
 * Plan Validate Agent - Plan-Intent Alignment Checker
 *
 * This agent detects when an AI's plan has drifted from the user's original
 * request. It catches contradictions, unrelated scope, and over-engineering.
 *
 * ## FLOW
 *
 * 1. Skip if no user messages or empty plan
 * 2. Run unified agent to check alignment
 * 3. Retry if format is invalid
 * 4. Return OK or DRIFT with feedback
 *
 * ## DRIFT DETECTION
 *
 * Detects:
 * - Plan contradicts user instructions
 * - Plan does something fundamentally different
 * - Plan adds major unrelated scope
 * - Plan includes test sections, time estimates, or manual build commands
 *
 * Allows:
 * - Incomplete but on-track plans
 * - Reasonable interpretation of ambiguous requests
 * - Plans mentioning check MCP tool for verification
 *
 * @module plan-validate
 */

import { getModelId } from '../../types.js';
import { runAgent } from '../../utils/agent-runner.js';
import { PLAN_VALIDATE_AGENT } from '../../utils/agent-configs.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

/**
 * Validate that a plan aligns with user intent.
 *
 * @param currentPlan - The full current plan file (null if new file)
 * @param toolName - The tool being used (Write or Edit)
 * @param toolInput - The tool input with content or old_string/new_string
 * @param conversationContext - Formatted conversation context
 * @returns Approval result with optional drift feedback
 *
 * @example
 * ```typescript
 * const result = await validatePlanIntent(currentPlan, "Edit", toolInput, context);
 * if (!result.approved) {
 *   console.log('Plan drift:', result.reason);
 * }
 * ```
 */
export async function validatePlanIntent(
  currentPlan: string | null,
  toolName: "Write" | "Edit",
  toolInput: { content?: string; old_string?: string; new_string?: string },
  conversationContext: string
): Promise<{ approved: boolean; reason?: string }> {
  // No conversation yet - nothing to validate against
  if (!conversationContext.trim()) {
    return { approved: true };
  }

  // Format proposed edit based on tool type
  const proposedEdit =
    toolName === "Write"
      ? toolInput.content ?? ""
      : `old_string: ${toolInput.old_string ?? ""}\nnew_string: ${toolInput.new_string ?? ""}`;

  // Empty proposed edit - allow
  if (!proposedEdit.trim()) {
    return { approved: true };
  }

  try {
    // Run plan validation via unified runner
    const initialResponse = await runAgent(
      { ...PLAN_VALIDATE_AGENT },
      {
        prompt: "Check if this plan aligns with the user request.",
        context: `CONVERSATION:\n${conversationContext}\n\nCURRENT PLAN:\n${currentPlan ?? "(new plan)"}\n\nPROPOSED ${toolName.toUpperCase()}:\n${proposedEdit}`,
      }
    );

    // Retry if format is invalid
    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId("sonnet"),
      initialResponse,
      `Plan validation for: ${proposedEdit.substring(0, 100)}...`,
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ["OK", "DRIFT:"]),
        formatReminder: "Reply with exactly: OK or DRIFT: <feedback>",
        maxTokens: 150,
      }
    );

    if (decision.startsWith("DRIFT:")) {
      const feedback = decision.replace("DRIFT:", "").trim();

      logToHomeAssistant({
        agent: "plan-validate",
        level: "decision",
        problem: `Plan ${toolName.toLowerCase()}: ${proposedEdit.substring(0, 100)}...`,
        answer: `DRIFT: ${feedback}`,
      });

      return {
        approved: false,
        reason: feedback,
      };
    }

    logToHomeAssistant({
      agent: "plan-validate",
      level: "decision",
      problem: `Plan ${toolName.toLowerCase()}: ${proposedEdit.substring(0, 100)}...`,
      answer: "OK",
    });

    return { approved: true };
  } catch (err) {
    // On issue, fail open (allow the write)
    logToHomeAssistant({
      agent: "plan-validate",
      level: "info",
      problem: "Validation issue",
      answer: String(err),
    });

    return { approved: true };
  }
}
