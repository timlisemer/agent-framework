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
import { getModelId } from "../../types.js";
import { runAgent } from "../../utils/agent-runner.js";
import { STYLE_DRIFT_AGENT } from "../../utils/agent-configs.js";
import { getAnthropicClient } from "../../utils/anthropic-client.js";
import { logToHomeAssistant } from "../../utils/logger.js";
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
 * Check an Edit tool call for style drift.
 *
 * @param toolName - Name of the tool being called (should be "Edit")
 * @param toolInput - Input parameters for the tool
 * @param workingDir - The project directory for context
 * @param userMessages - Recent user messages to check if style change was requested
 * @returns Approval result with optional denial reason
 *
 * @example
 * ```typescript
 * const result = await checkStyleDrift(
 *   "Edit",
 *   { file_path: "src/foo.ts", old_string: "'hello'", new_string: '"hello"' },
 *   "/path/to/project",
 *   "fix the login bug"
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
  userMessages?: string
): Promise<{ approved: boolean; reason?: string }> {
  // Only check Edit tool (has old/new comparison)
  if (toolName !== "Edit") {
    return { approved: true };
  }

  // Validate input structure
  if (!isEditToolInput(toolInput)) {
    return { approved: true };
  }

  const { file_path, old_string, new_string } = toolInput;

  // Early exits - not style drift scenarios
  if (!old_string.trim()) {
    // Insertion (new code) - always approve
    return { approved: true };
  }

  if (!new_string.trim()) {
    // Deletion - functional change, always approve
    return { approved: true };
  }

  // Load CLAUDE.md for style preferences
  let stylePreferences = "";
  const claudeMdPath = path.join(workingDir, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const content = fs.readFileSync(claudeMdPath, "utf-8");
    stylePreferences = extractStylePreferences(content);
  }

  const toolDescription = `Edit ${file_path}`;

  // Run style drift check via unified runner
  const initialResponse = await runAgent(
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
    initialResponse,
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) => startsWithAny(text, ["APPROVE", "DENY:"]),
      formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
    }
  );

  if (decision.startsWith("APPROVE")) {
    logToHomeAssistant({
      agent: "style-drift",
      level: "decision",
      problem: toolDescription,
      answer: "APPROVED",
    });
    return { approved: true };
  }

  // Extract reason from denial
  const reason = decision.startsWith("DENY: ")
    ? decision.replace("DENY: ", "")
    : `Malformed response: ${decision}`;

  logToHomeAssistant({
    agent: "style-drift",
    level: "decision",
    problem: toolDescription,
    answer: `DENIED: ${reason}`,
  });

  return {
    approved: false,
    reason,
  };
}
