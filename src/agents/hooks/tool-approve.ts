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
 * - File operations: Deny sensitive files (outside-project handled deterministically upstream)
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
import { RESTRICTED_MCP_TOOLS } from "../../utils/slash-commands.js";

export {
  FORBIDDEN_DENY_PATTERNS,
  FABRICATED_DENY_FINGERPRINTS,
  FORBIDDEN_DENY_PROMPT_LIST,
  isFabricatedDenyReason,
} from "../../utils/fabricated-deny-patterns.js";
import { isFabricatedDenyReason } from "../../utils/fabricated-deny-patterns.js";

export interface ToolApprovalOptions {
  skipLlmOnClean?: boolean;
  sessionDir?: string;
  planModeContext?: string;
  outsideRootPath?: string;
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

  // Deterministic deny for slash-command-gated MCP tools when no slash
  // command authorized this call. RESTRICTED_MCP_TOOLS is the single source
  // of truth (see src/utils/slash-commands.ts). Slash-authorized cases are
  // fast-allowed earlier in the pipeline at respond-first (priority 5),
  // so reaching here means no slash command authorizes the call. Replaces
  // the prior LLM-prose-mediated deny that produced "hard-coded denied
  // tool" hallucinations. Appeal helper remains as the user's escape hatch.
  if (RESTRICTED_MCP_TOOLS.has(toolName)) {
    return {
      approved: false,
      reason: `${toolName} requires explicit slash-command authorization (/commit, /push, /confirm, or /quickpush).`,
    };
  }

  // Skip LLM on clean: skip LLM if no blacklist violations (subagent fast path)
  if (options?.skipLlmOnClean && highlights.length === 0) {
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

  // TODO(Finding 11, deferred): a deterministic outside-root hard-deny was
  // proposed but defers parity. Today's LLM may approve outside-root edits in
  // legitimate cases the substring/basename test doesn't cover (e.g., user
  // says "fix the dotfile thing" → ~/.config/foo). Implement only with
  // explicit user approval. If implemented, consume
  // `state.currentPrediction.hasExplicitOverride` (already populated, see
  // EXPLICIT_OVERRIDE_RE in prediction-types.ts) and tighten the heuristic
  // to require the FULL absolute path or basenames >= ~10 chars.
  const outsideRootSection = options?.outsideRootPath
    ? `\n!!! WARNING: THIS TOOL CALL TARGETS A FILE OUTSIDE THE PROJECT ROOT\n` +
      `  target: ${options.outsideRootPath}\n` +
      `BE EXTRA CAREFUL AND CONSERVATIVE. Scrutinize intent heavily before ` +
      `approving. Prefer DENY unless the user's most recent message explicitly ` +
      `authorized editing this specific path. Routine, exploratory, or ` +
      `scope-creep edits to out-of-tree files must be denied. False denials ` +
      `here are much cheaper than false approvals.\n`
    : "";

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
${highlightSection}${gateReasoningSection}${options?.planModeContext ?? ""}${outsideRootSection}
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

      if (isFabricatedDenyReason(reason)) {
        console.error(
          `[tool-approve] Discarded hallucinated deny reason for ${toolName}: ${reason.slice(0, 200)}`
        );
        return { approved: true, gateNote: undefined };
      }

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
