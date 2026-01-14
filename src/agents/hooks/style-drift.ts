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
 * 2. Load CLAUDE.md for project style preferences
 * 3. Run unified agent to check for style drift
 * 4. Retry if format is invalid
 * 5. Return APPROVE or DENY with reason
 *
 * ## STYLE DRIFT EXAMPLES
 *
 * - Quote changes: ' to " or " to '
 * - Semicolon changes: ; to (none) or (none) to ;
 * - Trailing comma changes
 * - Import reordering (when imports unchanged)
 *
 * ## ALWAYS APPROVED
 *
 * - Any functional/logic change
 * - New code insertion (empty old_string)
 * - Code deletion (empty new_string)
 * - User-requested style changes
 *
 * @module style-drift
 */

import * as fs from "fs";
import * as path from "path";
import { getModelId, EXECUTION_TYPES } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { STYLE_DRIFT_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logApprove, logDeny, logFastPathApproval } from "../../utils/logger.js";
import { retryUntilValid, startsWithAny } from "../../utils/retry.js";

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
 * Common emoji ranges to detect additions.
 * Covers most used emojis in code/docs context.
 */
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{203C}\u{2049}]|[\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]|[\u{00A9}\u{00AE}]|[\u{2122}\u{2139}]|[\u{3030}\u{303D}]|[\u{3297}\u{3299}]/gu;

/**
 * Detect if new_string adds emojis not present in old_string.
 */
function detectEmojiAddition(oldStr: string, newStr: string): string[] {
  const oldEmojis = new Set(oldStr.match(EMOJI_REGEX) || []);
  const newEmojis = newStr.match(EMOJI_REGEX) || [];

  const addedEmojis = newEmojis.filter((e) => !oldEmojis.has(e));
  return [...new Set(addedEmojis)]; // dedupe
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

  const toolDescription = `Edit ${file_path}`;

  // Run style drift check via unified runner
  const result = await runAgent(
    { ...STYLE_DRIFT_AGENT, workingDir },
    {
      prompt: "Check if this edit contains unrequested style-only changes.",
      context: `STYLE PREFERENCES (from CLAUDE.md):
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
\`\`\`

Does this edit contain ONLY style changes that were NOT requested by the user?`,
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
    logApprove(result, "style-drift", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, decision);
    return { approved: true };
  }

  // Extract reason from denial
  const reason = decision.startsWith("DENY: ")
    ? decision.replace("DENY: ", "")
    : `Malformed response: ${decision}`;

  logDeny(result, "style-drift", hookName, toolName, workingDir, EXECUTION_TYPES.LLM, reason);

  return {
    approved: false,
    reason,
  };
}
