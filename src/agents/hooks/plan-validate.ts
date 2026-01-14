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

import { getModelId, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { PLAN_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { getBlacklistDescription, getContentBlacklistHighlights } from "../../utils/command-patterns.js";
import { getRuleViolationHighlights } from "../../utils/content-patterns.js";

/**
 * Validate that a plan aligns with user intent.
 *
 * @param currentPlan - The full current plan file (null if new file)
 * @param toolName - The tool being used (Write or Edit)
 * @param toolInput - The tool input with content or old_string/new_string
 * @param conversationContext - Formatted conversation context
 * @param transcriptPath - Path to the transcript file (for subagent detection)
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Approval result with optional drift feedback
 *
 * @example
 * ```typescript
 * const result = await checkPlanIntent(currentPlan, "Edit", toolInput, context, transcriptPath, cwd, "PreToolUse");
 * if (!result.approved) {
 *   console.log('Plan drift:', result.reason);
 * }
 * ```
 */
export async function checkPlanIntent(
  currentPlan: string | null,
  toolName: "Write" | "Edit",
  toolInput: { content?: string; old_string?: string; new_string?: string },
  conversationContext: string,
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
  // Skip plan validation for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "Subagent skip");
    return { approved: true };
  }

  // No conversation yet - nothing to validate against
  if (!conversationContext.trim()) {
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "No conversation context");
    return { approved: true };
  }

  // Format proposed edit based on tool type
  const proposedEdit =
    toolName === "Write"
      ? toolInput.content ?? ""
      : `old_string: ${toolInput.old_string ?? ""}\nnew_string: ${toolInput.new_string ?? ""}`;

  // Empty proposed edit - allow
  if (!proposedEdit.trim()) {
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "Empty proposed edit");
    return { approved: true };
  }

  try {
    // Check for violations in proposed edit
    const blacklistHighlights = getContentBlacklistHighlights(proposedEdit);
    const ruleViolations = getRuleViolationHighlights(proposedEdit);
    const allViolations = [...blacklistHighlights, ...ruleViolations];
    const violationSection = allViolations.length > 0
      ? `=== VIOLATIONS DETECTED ===\n${allViolations.join("\n")}\n=== END VIOLATIONS ===\n\n`
      : "";

    // Run plan validation via unified runner
    const result = await runAgent(
      { ...PLAN_VALIDATE_AGENT },
      {
        prompt: "Check if this plan aligns with the user request.",
        context: `CONVERSATION:\n${conversationContext}\n\nCURRENT PLAN:\n${currentPlan ?? "(new plan)"}\n\nPROPOSED ${toolName.toUpperCase()}:\n${proposedEdit}\n\n${violationSection}=== BLACKLISTED COMMANDS ===\n${getBlacklistDescription()}\n=== END BLACKLIST ===`,
      }
    );

    // Retry if format is invalid
    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId(PLAN_VALIDATE_AGENT.tier),
      result.output,
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

      logDeny(result, "plan-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, feedback);

      return {
        approved: false,
        reason: feedback,
      };
    }

    logApprove(result, "plan-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, "Plan aligned");

    return { approved: true };
  } catch {
    // On error, fail open (allow the write)
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "Error path - fail open");
    return { approved: true };
  }
}
