/**
 * CLAUDE.md Validation Agent
 *
 * Validates CLAUDE.md file edits against hardcoded agent-framework rules.
 * Uses direct mode with all rules embedded in the system prompt.
 *
 * ## FLOW
 *
 * 1. Receive current file content and proposed edit
 * 2. Run direct agent with structured context
 * 3. Retry if format is invalid
 * 4. Return OK or DRIFT with feedback
 *
 * @module claude-md-validate
 */

import { getModelId, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { CLAUDE_MD_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import { isSubagent } from "../../utils/subagent-detector.js";
import { getBlacklistDescription, getContentBlacklistHighlights } from "../../utils/command-patterns.js";

/**
 * Validate CLAUDE.md content against agent-framework rules.
 *
 * @param currentContent - The full current file content (null if new file)
 * @param toolName - The tool being used (Write or Edit)
 * @param toolInput - The tool input with content or old_string/new_string
 * @param transcriptPath - Path to the transcript file (for subagent detection)
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Validation result with approved status and optional reason
 *
 * @example
 * ```typescript
 * const result = await validateClaudeMd(currentContent, "Edit", toolInput, transcriptPath, cwd, "PreToolUse");
 * if (!result.approved) {
 *   console.log('CLAUDE.md drift:', result.reason);
 * }
 * ```
 */
export async function validateClaudeMd(
  currentContent: string | null,
  toolName: "Write" | "Edit",
  toolInput: { content?: string; old_string?: string; new_string?: string },
  transcriptPath: string,
  workingDir: string,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
  // Skip CLAUDE.md validation for subagents (Task-spawned agents)
  if (isSubagent(transcriptPath)) {
    logFastPathApproval("claude-md-validate", hookName, toolName, workingDir, "Subagent skip");
    return { approved: true };
  }

  // Format proposed edit based on tool type
  const proposedEdit =
    toolName === "Write"
      ? toolInput.content ?? ""
      : `old_string: ${toolInput.old_string ?? ""}\nnew_string: ${toolInput.new_string ?? ""}`;

  // Empty proposed edit - allow
  if (!proposedEdit.trim()) {
    logFastPathApproval("claude-md-validate", hookName, toolName, workingDir, "Empty proposed edit");
    return { approved: true };
  }

  try {
    // Check for blacklisted commands in proposed edit
    const blacklistHighlights = getContentBlacklistHighlights(proposedEdit);
    const blacklistSection = blacklistHighlights.length > 0
      ? `=== BLACKLISTED PATTERNS DETECTED ===\n${blacklistHighlights.join("\n")}\n=== END VIOLATIONS ===\n\n`
      : "";

    const result = await runAgent(
      { ...CLAUDE_MD_VALIDATE_AGENT, workingDir },
      {
        prompt: "Validate this CLAUDE.md content.",
        context: `CURRENT FILE:\n${currentContent ?? "(new file)"}\n\nPROPOSED ${toolName.toUpperCase()}:\n${proposedEdit}\n\n${blacklistSection}=== BLACKLISTED COMMANDS ===\n${getBlacklistDescription()}\n=== END BLACKLIST ===`,
      }
    );

    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId(CLAUDE_MD_VALIDATE_AGENT.tier),
      result.output,
      "CLAUDE.md validation",
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ["OK", "DRIFT:"]),
        formatReminder: "Reply: OK or DRIFT: <feedback>",
        maxTokens: 150,
      }
    );

    if (decision.startsWith("DRIFT:")) {
      const feedback = decision.replace("DRIFT:", "").trim();
      logDeny(result, "claude-md-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, feedback);
      return { approved: false, reason: feedback };
    }

    logApprove(result, "claude-md-validate", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, "Valid CLAUDE.md edit");
    return { approved: true };
  } catch {
    // Fail open on errors
    logFastPathApproval("claude-md-validate", hookName, toolName, workingDir, "Error path - fail open");
    return { approved: true };
  }
}
