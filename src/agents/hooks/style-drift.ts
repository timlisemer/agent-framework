/**
 * Style Drift Agent - Detect Unrequested Style Changes
 *
 * This agent detects when AI makes cosmetic/style-only changes that were
 * not explicitly requested by the user. It protects against unwanted
 * code formatting changes like quote style switches.
 *
 * ## FLOW
 *
 * 1. Early exit if not a modification (insertion or deletion)
 * 2. Fast-path: Emoji additions → DENY
 * 3. Detect style changes with preference flags
 * 4. Fast-path: Quote away from preference → DENY
 * 5. Fast-path: Quote toward preference (only change) → APPROVE
 * 6. Fast-path: No style changes → APPROVE
 * 7. LLM confirmation for semicolon/trailing comma changes
 *
 * ## FAST-PATH DECISIONS
 *
 * - Quote " → ' when preference is double → FAST DENY
 * - Quote ' → " when preference is double → FAST APPROVE
 * - Emoji additions → FAST DENY
 * - No style changes detected → FAST APPROVE
 *
 * ## LLM CONFIRMATION
 *
 * - Semicolon changes → LLM verifies if requested
 * - Trailing comma changes → LLM verifies if requested
 * - Mixed quote + other changes → LLM verifies
 *
 * @module style-drift
 */

import * as fs from "fs";
import * as path from "path";
import { getModelId, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { STYLE_DRIFT_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval, logAgentStarted } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";
import {
  detectEmojiAddition,
  detectStyleChanges,
  formatStyleHints,
} from "../../utils/content-patterns.js";

/**
 * Input shape for Edit tool
 */
interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

/**
 * Check if a tool input looks like an Edit tool input
 */
function isEditToolInput(input: unknown): input is EditToolInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return (
    typeof obj.file_path === "string" &&
    typeof obj.old_string === "string" &&
    typeof obj.new_string === "string"
  );
}

/**
 * Extract style-related preferences from CLAUDE.md content.
 *
 * Looks for sections containing keywords like "quote", "style", "format".
 */
function extractStylePreferences(claudeMdContent: string): string {
  const lines = claudeMdContent.split("\n");
  const relevantLines: string[] = [];
  const keywords = [
    "quote",
    "style",
    "format",
    "semicolon",
    "trailing",
    "comma",
    "indent",
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].toLowerCase();
    if (keywords.some((kw) => line.includes(kw))) {
      // Include this line and a few lines of context
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 3);
      for (let j = start; j < end; j++) {
        if (!relevantLines.includes(lines[j])) {
          relevantLines.push(lines[j]);
        }
      }
    }
  }

  return relevantLines.join("\n");
}

/**
 * Check an Edit tool call for style drift.
 *
 * @param toolName - Name of the tool being called (should be "Edit")
 * @param toolInput - Input parameters for the tool
 * @param workingDir - The project directory for context
 * @param userMessages - Recent user messages to check if style change was requested
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Approval result with optional denial reason
 *
 * @example
 * ```typescript
 * const result = await checkStyleDrift(
 *   "Edit",
 *   { file_path: "src/foo.ts", old_string: "'hello'", new_string: '"hello"' },
 *   "/path/to/project",
 *   "fix the login bug",
 *   "PreToolUse"
 * );
 * if (!result.approved) {
 *   console.log("Style drift:", result.reason);
 * }
 * ```
 */
export async function checkStyleDrift(
  toolName: string,
  toolInput: unknown,
  workingDir: string,
  userMessages: string | undefined,
  hookName: string
): Promise<{ approved: boolean; reason?: string }> {
  // Only check Edit tool (has old/new comparison)
  if (toolName !== "Edit") {
    logFastPathApproval("style-drift", hookName, toolName, workingDir, "Non-Edit tool");
    return { approved: true };
  }

  // Validate input structure
  if (!isEditToolInput(toolInput)) {
    logFastPathApproval("style-drift", hookName, toolName, workingDir, "Invalid input structure");
    return { approved: true };
  }

  const { file_path, old_string, new_string } = toolInput;

  // Early exits - not style drift scenarios
  if (!old_string.trim()) {
    // Insertion (new code) - always approve
    logFastPathApproval("style-drift", hookName, toolName, workingDir, "Insertion (new code)");
    return { approved: true };
  }

  if (!new_string.trim()) {
    // Deletion - functional change, always approve
    logFastPathApproval("style-drift", hookName, toolName, workingDir, "Deletion");
    return { approved: true };
  }

  // Fast-path: Detect emoji additions (always block, even in mixed changes)
  const addedEmojis = detectEmojiAddition(old_string, new_string);
  if (addedEmojis.length > 0) {
    const reason = `emoji added (${addedEmojis.join(", ")}) - remove emoji`;
    logDeny(
      {
        output: reason,
        latencyMs: 0,
        success: true,
        errorCount: 0,
        modelTier: STYLE_DRIFT_AGENT.tier,
        modelName: getModelId(STYLE_DRIFT_AGENT.tier),
      },
      "style-drift",
      hookName,
      toolName,
      workingDir,
      EXECUTION_TYPES.TYPESCRIPT,
      reason
    );
    return { approved: false, reason };
  }

  // Load CLAUDE.md for style preferences
  let stylePreferences = "";
  const claudeMdPath = path.join(workingDir, "CLAUDE.md");
  try {
    const content = await fs.promises.readFile(claudeMdPath, "utf-8");
    stylePreferences = extractStylePreferences(content);
  } catch {
    // File doesn't exist or read error - use defaults
  }

  // Detect style changes with preference flags (default: double quotes)
  const styleChanges = detectStyleChanges(old_string, new_string, "double");

  // Fast-path A.1: Quote changes AWAY from preference → DENY
  const quoteViolation = styleChanges.find(
    (c) => c.type === "quote" && c.violatesPreference
  );
  if (quoteViolation) {
    const reason = `quote change (${quoteViolation.direction}) violates project preference - use double quotes`;
    logDeny(
      {
        output: reason,
        latencyMs: 0,
        success: true,
        errorCount: 0,
        modelTier: STYLE_DRIFT_AGENT.tier,
        modelName: getModelId(STYLE_DRIFT_AGENT.tier),
      },
      "style-drift",
      hookName,
      toolName,
      workingDir,
      EXECUTION_TYPES.TYPESCRIPT,
      reason
    );
    return { approved: false, reason };
  }

  // Fast-path A.2: Quote changes TOWARD preference (cleanup) → APPROVE
  const quoteMatch = styleChanges.find(
    (c) => c.type === "quote" && c.matchesPreference
  );
  if (quoteMatch) {
    // Only fast-approve if this is the ONLY change (pure cleanup)
    const otherChanges = styleChanges.filter((c) => c.type !== "quote");
    if (otherChanges.length === 0) {
      logFastPathApproval(
        "style-drift",
        hookName,
        toolName,
        workingDir,
        "Quote cleanup toward preference"
      );
      return { approved: true };
    }
    // Otherwise, there are other style changes - continue to LLM check
  }

  // Fast-path C: No style changes detected → APPROVE
  if (styleChanges.length === 0) {
    logFastPathApproval(
      "style-drift",
      hookName,
      toolName,
      workingDir,
      "No style changes"
    );
    return { approved: true };
  }

  // LLM confirmation: Other style changes (semicolon, trailing comma) need verification
  const hintSection = formatStyleHints(styleChanges);
  const toolDescription = `Edit ${file_path}`;

  // Mark agent as running in statusline
  logAgentStarted("style-drift", toolName);

  const result = await runAgent(
    { ...STYLE_DRIFT_AGENT, workingDir },
    {
      prompt: "Verify if these style changes were requested.",
      context: `${hintSection}
STYLE PREFERENCES (from CLAUDE.md):
${stylePreferences || "Default: double quotes, follow existing file conventions"}

RECENT USER MESSAGES:
${userMessages || "No user messages available"}

EDIT DETAILS:
File: ${file_path}

Old content:
\`\`\`
${old_string}
\`\`\`

New content:
\`\`\`
${new_string}
\`\`\``,
    }
  );

  // Retry if format is invalid (must start with APPROVE or DENY:)
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId(STYLE_DRIFT_AGENT.tier),
    result.output,
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) => startsWithAny(text, ["APPROVE", "DENY:"]),
      formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
    }
  );

  if (decision.startsWith("APPROVE")) {
    logApprove(
      result,
      "style-drift",
      hookName,
      toolName,
      workingDir,
      EXECUTION_TYPES.LLM,
      decision
    );
    return { approved: true };
  }

  // Extract reason from denial
  const reason = decision.startsWith("DENY: ")
    ? decision.replace("DENY: ", "")
    : `Malformed response: ${decision}`;

  logDeny(
    result,
    "style-drift",
    hookName,
    toolName,
    workingDir,
    EXECUTION_TYPES.LLM,
    reason
  );

  return {
    approved: false,
    reason,
  };
}
