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

import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { CLAUDE_MD_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { getContentBlacklistHighlights } from "../../utils/command-patterns.js";
import { getRuleViolationHighlights } from "../../utils/content-patterns.js";

/**
 * Validate CLAUDE.md content against agent-framework rules.
 *
 * @param currentContent - The full current file content (null if new file)
 * @param toolName - The tool being used (Write or Edit)
 * @param toolInput - The tool input with content or old_string/new_string
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Validation result with approved status and optional reason
 *
 * @example
 * ```typescript
 * const result = await validateClaudeMd(currentContent, "Edit", toolInput, cwd, "PreToolUse");
 * if (!result.approved) {
 *   console.log('CLAUDE.md drift:', result.reason);
 * }
 * ```
 */
export async function validateClaudeMd(
  currentContent: string | null,
  toolName: "Write" | "Edit",
  toolInput: { content?: string; old_string?: string; new_string?: string },
  workingDir: string,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
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
    // Check for violations in proposed edit. CLAUDE.md uses inverseCodeBlocks
    // mode: blacklisted commands inside fenced ```...``` blocks are the
    // violation (CLAUDE.md should not document them as runnable). Any such
    // hit is a hard deny — there is no Manual User Verification carve-out
    // in CLAUDE.md.
    const codeBlockHits = getContentBlacklistHighlights(proposedEdit, {
      inverseCodeBlocks: true,
    });
    if (codeBlockHits.length > 0) {
      const feedback = codeBlockHits
        .map((h) => h.rendered.replace(/^\[VIOLATION: [^\]]+\]\s*/, ""))
        .join(". ");
      return {
        approved: false,
        reason: `${feedback}\nRemember: these rules apply to ALL content in the CLAUDE.md, not just the current edit.`,
      };
    }

    const proseBlacklistHits = getContentBlacklistHighlights(proposedEdit);
    const blacklistHighlights = proseBlacklistHits.map((h) => h.rendered);
    const ruleViolations = getRuleViolationHighlights(proposedEdit);
    const allViolations = [...blacklistHighlights, ...ruleViolations];
    const violationSection = allViolations.length > 0
      ? `=== VIOLATIONS DETECTED ===\n${allViolations.join("\n")}\n=== END VIOLATIONS ===\n\n`
      : "";

    // Run CLAUDE.md validation with retry and telemetry
    const result = await runAgentWithRetryAndTelemetry(
      { ...CLAUDE_MD_VALIDATE_AGENT, workingDir },
      {
        prompt: "Validate this CLAUDE.md content.",
        context: `CURRENT FILE:\n${currentContent ?? "(new file)"}\n\nPROPOSED ${toolName.toUpperCase()}:\n${proposedEdit}\n\n${violationSection}`,
      },
      {
        formatValidator: (text) => startsWithAny(text, ["OK", "DRIFT:"]),
        formatReminder: "Reply: OK or DRIFT: <feedback>",
        maxTokens: 512,
        context: "CLAUDE.md validation",
      },
      { agent: "claude-md-validate", hookName, toolName, workingDir, executionType: EXECUTION_TYPES.LLM }
    );

    if (result.output.startsWith("OK")) {
      return { approved: true };
    }

    if (result.output.startsWith("DRIFT:")) {
      const feedback = result.output.replace("DRIFT:", "").trim();
      const fullFeedback = `${feedback}\nRemember: these rules apply to ALL content in the CLAUDE.md, not just the current edit.`;
      return { approved: false, reason: fullFeedback };
    }

    // Fail closed if response is malformed after retries
    return { approved: false, reason: "Malformed response - retry the edit" };
  } catch {
    // Fail closed on errors
    logFastPathApproval("claude-md-validate", hookName, toolName, workingDir, "Error path - fail closed");
    return { approved: false, reason: "Error during validation - retry the edit" };
  }
}
