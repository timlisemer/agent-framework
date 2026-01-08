/**
 * Tool Appeal Agent - Helper for Denied Tool Calls
 *
 * This agent is a HELPER called by other agents after they block a tool.
 * It reviews the denial and returns whether to overturn it.
 * The CALLING agent decides what to do with the result.
 *
 * ## FLOW
 *
 * 1. Receive denial reason and transcript context from calling agent
 * 2. Run LLM to evaluate if user approved the operation
 * 3. Retry if format is invalid
 * 4. Return { overturned: boolean } - caller decides what to do
 *
 * ## CRITICAL
 *
 * - This agent does NOT make final decisions
 * - It only checks if user explicitly approved the operation
 * - The calling agent handles the response in TypeScript
 *
 * @module tool-appeal
 */

import { getModelId } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { TOOL_APPEAL_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";

/**
 * Appeal helper - called by other agents after they block a tool.
 * Returns whether user has approved this operation.
 *
 * The CALLING agent decides what to do with the result.
 *
 * @param toolName - Name of the tool being appealed
 * @param toolDescription - Human-readable description of the tool call
 * @param transcript - Recent conversation context
 * @param originalReason - The original denial reason from the calling agent
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @param additionalContext - Extra context from calling agent (e.g., why it blocked)
 * @returns { overturned: boolean } - caller decides what to do
 *
 * @example
 * ```typescript
 * const result = await appealHelper(
 *   'Bash',
 *   'Bash with {"command": "curl ..."}',
 *   transcript,
 *   'Network requests denied by default',
 *   '/path/to/project',
 *   'PreToolUse',
 *   'error-acknowledge blocked because AI ignored build error'
 * );
 * if (result.overturned) {
 *   // User approved - caller continues flow
 * } else {
 *   // User did not approve - caller blocks tool
 * }
 * ```
 */
export async function appealHelper(
  toolName: string,
  toolDescription: string,
  transcript: string,
  originalReason: string,
  workingDir: string,
  hookName: string,
  additionalContext?: string
): Promise<{ overturned: boolean }> {
  // Build context section from calling agent
  const contextSection = additionalContext
    ? `\n=== CALLER CONTEXT ===\n${additionalContext}\n=== END CONTEXT ===\n`
    : "";

  // Run appeal evaluation via unified runner
  const result = await runAgent(
    { ...TOOL_APPEAL_AGENT, workingDir },
    {
      prompt: "Review this appeal for a denied tool call.",
      context: `BLOCK REASON: ${originalReason}
TOOL CALL: ${toolDescription}
${contextSection}
RECENT CONVERSATION:
${transcript}`,
    }
  );

  // Retry if format is invalid
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId(TOOL_APPEAL_AGENT.tier),
    result.output,
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) =>
        startsWithAny(text, ["UPHOLD", "OVERTURN: APPROVE"]),
      formatReminder:
        "Reply with EXACTLY: UPHOLD or OVERTURN: APPROVE",
    }
  );

  // Check for overturn (user approved)
  const overturned = decision.startsWith("OVERTURN: APPROVE") || decision === "APPROVE";

  if (overturned) {
    logApprove(result, "tool-appeal", hookName, toolName, workingDir, "direct", "llm", "User approved operation");
  } else {
    logDeny(result, "tool-appeal", hookName, toolName, workingDir, "llm", "User did not approve");
  }

  return { overturned };
}
