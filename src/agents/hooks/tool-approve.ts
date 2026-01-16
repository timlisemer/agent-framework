/**
 * Tool Approve Agent - Policy Enforcement Gate
 *
 * This agent evaluates tool calls for safety and compliance with project rules.
 * It's the first line of defense in the pre-tool-use hook.
 *
 * ## FLOW
 *
 * 1. Load project rules from CLAUDE.md if exists
 * 2. Get blacklist pattern highlights for the tool call
 * 3. Run unified agent to evaluate
 * 4. Retry if format is invalid
 * 5. Return APPROVE or DENY with reason
 *
 * ## RULES ENFORCED
 *
 * - File operations: Deny outside project, deny sensitive files
 * - Bash: Deny cd, deny tool duplication, deny git write ops
 * - Build: Deny make check/build (use MCP tools)
 * - Network: Deny curl/wget by default
 *
 * See agent-configs.ts for full rule list.
 *
 * @module tool-approve
 */

import * as fs from "fs";
import * as path from "path";
import { getModelId, EXECUTION_MODES, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { TOOL_APPROVE_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { getBlacklistHighlights } from "../../utils/command-patterns.js";
import { setExecutionMode } from "../../utils/execution-context.js";
import { logApprove, logDeny, logFastPathApproval, logAgentStarted } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";

export interface ToolApprovalOptions {
  /** Skip LLM if no blacklist matches (for lazy mode) */
  lazyMode?: boolean;
}

/**
 * Evaluate a tool call for safety and compliance.
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @param workingDir - The project directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @param options - Optional settings (e.g., lazyMode to skip LLM if no blacklist)
 * @returns Approval result with optional denial reason
 *
 * @example
 * ```typescript
 * const result = await checkToolApproval('Bash', { command: 'rm -rf /' }, '/path/to/project', 'PreToolUse');
 * if (!result.approved) {
 *   console.log('Denied:', result.reason);
 * }
 * ```
 */
export async function checkToolApproval(
  toolName: string,
  toolInput: unknown,
  workingDir: string,
  hookName: string,
  options?: ToolApprovalOptions
): Promise<{ approved: boolean; reason?: string }> {
  // Get blacklist pattern highlights for this tool call
  const highlights = getBlacklistHighlights(toolName, toolInput);

  // Lazy mode: skip LLM if no blacklist violations
  if (options?.lazyMode && highlights.length === 0) {
    setExecutionMode(EXECUTION_MODES.LAZY);
    logFastPathApproval("tool-approve", hookName, toolName, workingDir, "No blacklist violations");
    return { approved: true };
  }

  // Load CLAUDE.md if exists (project-specific rules)
  let rules = "";
  const claudeMdPath = path.join(workingDir, "CLAUDE.md");
  try {
    await fs.promises.access(claudeMdPath);
    rules = await fs.promises.readFile(claudeMdPath, "utf-8");
  } catch {
    // No CLAUDE.md, that's fine
  }

  const toolDescription = `${toolName} with ${JSON.stringify(toolInput)}`;
  const highlightSection =
    highlights.length > 0
      ? `\n=== BLACKLISTED PATTERNS DETECTED ===\n${highlights.join("\n")}\n=== END BLACKLIST ===\n`
      : "";

  // Mark agent as running in statusline
  logAgentStarted("tool-approve", toolName);

  // Retry with exponential backoff, fail closed on final failure
  const maxRetries = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Run initial evaluation via unified runner
      const result = await runAgent(
        { ...TOOL_APPROVE_AGENT, workingDir },
        {
          prompt: "Evaluate this tool call for safety and compliance.",
          context: `PROJECT DIRECTORY: ${workingDir}

PROJECT RULES (from CLAUDE.md):
${rules || "No project-specific rules."}
${highlightSection}
TOOL TO EVALUATE:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}`,
        }
      );

      // Retry if format is invalid (must start with APPROVE or DENY:)
      const anthropic = getAnthropicClient();
      const decision = await retryUntilValid(
        anthropic,
        getModelId(TOOL_APPROVE_AGENT.tier),
        result.output,
        toolDescription,
        {
          maxRetries: 2,
          formatValidator: (text) => startsWithAny(text, ["APPROVE", "DENY:"]),
          formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
        }
      );

      if (decision.startsWith("APPROVE")) {
        logApprove(result, "tool-approve", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, decision);
        return { approved: true };
      }

      // Default to DENY for safety - extract reason from response
      const reason = decision.startsWith("DENY: ")
        ? decision.replace("DENY: ", "")
        : `Malformed response: ${decision}`;

      logDeny(result, "tool-approve", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, reason);

      return {
        approved: false,
        reason,
      };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        // Exponential backoff: 100ms, 200ms
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }

  // All retries failed - fail closed (deny tool)
  logFastPathApproval("tool-approve", hookName, toolName, workingDir, `Error after ${maxRetries + 1} attempts - fail closed: ${lastError}`);
  return { approved: false, reason: "Tool approval failed due to internal error - please try again" };
}
