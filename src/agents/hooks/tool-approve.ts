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
 * - Build: Deny make/just check/build (use MCP tools)
 * - Network: Deny curl/wget by default
 *
 * See agent-configs.ts for full rule list.
 *
 * @module tool-approve
 */

import * as fs from "fs";
import * as path from "path";
import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { TOOL_APPROVE_AGENT } from "../../utils/agent-configs.js";
import { getBlacklistHighlights } from "../../utils/command-patterns.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { extractGateNote, formatForPrompt } from "../../utils/gate-reasoning-cache.js";
import { planModeEditBlock, planModeBashBlock } from "../../utils/edit-intent.js";

export interface ToolApprovalOptions {
  lazyMode?: boolean;
  sessionDir?: string;
  planModeContext?: string;
}

export async function checkToolApproval(
  toolName: string,
  toolInput: unknown,
  workingDir: string,
  hookName: string,
  options?: ToolApprovalOptions
): Promise<{ approved: boolean; reason?: string; gateNote?: string }> {
  if (options?.planModeContext) {
    const input = toolInput as Record<string, unknown>;
    const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
    const editBlock = planModeEditBlock(true, toolName, filePath);
    if (editBlock) {
      return { approved: false, reason: editBlock };
    }
    const bashBlock = planModeBashBlock(true, toolName, (input?.command as string) ?? "");
    if (bashBlock) {
      return { approved: false, reason: bashBlock };
    }
  }

  const highlights = getBlacklistHighlights(toolName, toolInput, workingDir);

  // Deterministic deny for blacklisted patterns — bypasses LLM (appeal system still provides override)
  if (highlights.length > 0) {
    const reason = highlights.map(h => h.replace(/^\[BLACKLIST: [^\]]+\]\s*/, "")).join(". ");
    return { approved: false, reason };
  }

  // Lazy mode: skip LLM if no blacklist violations
  if (options?.lazyMode && highlights.length === 0) {
    logFastPathApproval("tool-approve", hookName, toolName, workingDir, "No blacklist violations");
    return { approved: true };
  }

  // Load CLAUDE.md if exists
  let rules = "";
  const claudeMdPath = path.join(workingDir, "CLAUDE.md");
  try {
    await fs.promises.access(claudeMdPath);
    rules = await fs.promises.readFile(claudeMdPath, "utf-8");
  } catch {
    // No CLAUDE.md
  }

  const highlightSection = highlights.length > 0
    ? `\n=== BLACKLISTED PATTERNS DETECTED ===\n${highlights.join("\n")}\n=== END BLACKLIST ===\n`
    : "";

  // Read gate reasoning if sessionDir is available
  let gateReasoningSection = "";
  if (options?.sessionDir) {
    try {
      const reasoning = await formatForPrompt(options.sessionDir);
      if (reasoning) {
        gateReasoningSection = `\nRECENT GATE REASONING:\n${reasoning}\n`;
      }
    } catch {
      // No gate reasoning yet
    }
  }

  // Retry with exponential backoff
  const maxRetries = 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await runAgentWithRetryAndTelemetry(
        { ...TOOL_APPROVE_AGENT, workingDir },
        {
          prompt: "Evaluate this tool call for safety and compliance.",
          context: `PROJECT DIRECTORY: ${workingDir}

PROJECT RULES (from CLAUDE.md):
${rules || "No project-specific rules."}
${highlightSection}${gateReasoningSection}${options?.planModeContext ?? ""}
TOOL TO EVALUATE:
Tool: ${toolName}
Input: ${JSON.stringify(toolInput)}`,
        },
        {
          formatValidator: (text) => startsWithAny(text, ["APPROVE", "DENY:"]),
          formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
        },
        {
          agent: "tool-approve",
          hookName,
          toolName,
          workingDir,
          executionType: EXECUTION_TYPES.LLM,
        }
      );

      // Extract optional gate note
      const gateNote = extractGateNote(result.output);

      if (result.output.startsWith("APPROVE")) {
        return { approved: true, gateNote };
      }

      const reason = result.output.startsWith("DENY: ")
        ? result.output.replace("DENY: ", "")
        : `Malformed response: ${result.output}`;

      return { approved: false, reason, gateNote };
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt)));
      }
    }
  }

  logFastPathApproval("tool-approve", hookName, toolName, workingDir, `Error after ${maxRetries + 1} attempts - fail closed: ${lastError}`);
  return { approved: false, reason: "Tool approval failed due to internal error - please try again" };
}
