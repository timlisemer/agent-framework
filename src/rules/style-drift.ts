import * as fs from "fs";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { extractFilePaths, isTrustedPath, isSensitivePath } from "./utils.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { STYLE_DRIFT_COUNTS } from "../utils/transcript-presets.js";
import {
  detectEmojiAddition,
  detectStyleChanges,
  formatStyleHints,
  extractStylePreferences,
} from "../utils/content-patterns.js";
import { STYLE_DRIFT_PROMPT_SECTION } from "../utils/agent-configs.js";
import { activeSpec } from "../adapter/spec.js";

/**
 * Input shape for Edit tool
 */
interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
}

function isEditToolInput(input: unknown): input is EditToolInput {
  if (typeof input !== "object" || input === null) return false;
  const obj = input as Record<string, unknown>;
  return (
    typeof obj.file_path === "string" &&
    typeof obj.old_string === "string" &&
    typeof obj.new_string === "string"
  );
}

export const styleDriftRule: PreToolRule = {
  name: "style-drift",
  displayName: "Style Drift",
  priority: 65,
  appealable: false,
  usesLlm: true,
  events: ["PreToolUse"],
  promptSection: STYLE_DRIFT_PROMPT_SECTION,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== "Edit") {
      return null;
    }

    const eligibleFilePaths = extractFilePaths(ctx.toolName, ctx.toolInput).filter((filePath) =>
      isTrustedPath(filePath, ctx.projectDir) && !isSensitivePath(filePath)
    );

    if (eligibleFilePaths.length === 0) {
      return null;
    }

    if (!isEditToolInput(ctx.toolInput)) {
      return null;
    }

    const { file_path, old_string, new_string } = ctx.toolInput;

    // Pure insertion or deletion — not a style drift scenario
    if (!old_string.trim()) {
      return null;
    }
    if (!new_string.trim()) {
      return null;
    }

    // Fast-path: Detect emoji additions (always deny, even in mixed changes)
    const addedEmojis = detectEmojiAddition(old_string, new_string);
    if (addedEmojis.length > 0) {
      return { fastDeny: `emoji added (${addedEmojis.join(", ")}) - remove emoji` };
    }

    // Detect style changes with preference flags (default: double quotes)
    const styleChanges = detectStyleChanges(old_string, new_string, "double");

    // Fast-path: Emdash present in new content → deny
    const emdashChanges = styleChanges.filter((c) => c.type === "emdash");
    if (emdashChanges.length > 0) {
      return { fastDeny: "emdash detected - replace with normal dash (-)" };
    }

    // Fast-path: Backtick-only additions → deny (cosmetic formatting, not requested)
    const backtickChanges = styleChanges.filter((c) => c.type === "backtick");
    const nonBacktickChanges = styleChanges.filter((c) => c.type !== "backtick");
    if (
      nonBacktickChanges.length === 0 &&
      backtickChanges.length > 0 &&
      backtickChanges.every((c) => c.direction === "added")
    ) {
      return { fastDeny: "backticks added (cosmetic formatting) - remove backticks" };
    }

    // Fast-path: No style changes detected → pass (no LLM needed)
    if (styleChanges.length === 0) {
      return null;
    }

    // Separate quote and non-quote changes
    const quoteChanges = styleChanges.filter((c) => c.type === "quote");
    const nonQuoteChanges = styleChanges.filter((c) => c.type !== "quote");

    // Fast-path: Only quote changes away from preference → deny
    if (nonQuoteChanges.length === 0 && quoteChanges.some((c) => c.violatesPreference)) {
      return { fastDeny: "quote style changed away from preference - use double quotes" };
    }

    // Fast-path: Only quote changes toward preference → pass (no LLM needed)
    if (
      nonQuoteChanges.length === 0 &&
      quoteChanges.length > 0 &&
      quoteChanges.every((c) => c.matchesPreference)
    ) {
      return null;
    }

    // Residual ambiguous case (semicolon / trailing-comma / mixed) → llmContext
    const hintSection = formatStyleHints(styleChanges);

    // Load active adapter's instruction files for style preferences
    // (Claude: CLAUDE.md; Codex: AGENTS.md + CLAUDE.md).
    const host = activeSpec().resolveHostContext({ cwd: ctx.projectDir });
    let stylePreferences = "";
    for (const instructionPath of host.instructionFiles) {
      try {
        const content = await fs.promises.readFile(instructionPath, "utf-8");
        const extracted = extractStylePreferences(content);
        if (extracted) {
          stylePreferences = stylePreferences
            ? `${stylePreferences}\n${extracted}`
            : extracted;
        }
      } catch {
        // File doesn't exist or read error — try next
      }
    }

    const transcriptResult = await readTranscriptExact(ctx.transcriptPath, STYLE_DRIFT_COUNTS);
    const userMessages = formatTranscriptResult(transcriptResult);

    const MAX_CONTENT_LENGTH = 2000;
    const truncatedOld =
      old_string.length > MAX_CONTENT_LENGTH
        ? old_string.slice(0, MAX_CONTENT_LENGTH) + "\n... (truncated)"
        : old_string;
    const truncatedNew =
      new_string.length > MAX_CONTENT_LENGTH
        ? new_string.slice(0, MAX_CONTENT_LENGTH) + "\n... (truncated)"
        : new_string;

    const llmContext =
      `${hintSection}\n` +
      `STYLE PREFERENCES (from ${host.instructionLabel}):\n${stylePreferences || "Default: double quotes, follow existing file conventions"}\n\n` +
      `RECENT USER MESSAGES:\n${userMessages || "No user messages available"}\n\n` +
      `EDIT DETAILS:\nFile: ${eligibleFilePaths.join(", ") || file_path}\n\n` +
      `Old content:\n\`\`\`\n${truncatedOld}\n\`\`\`\n\n` +
      `New content:\n\`\`\`\n${truncatedNew}\n\`\`\``;

    return { llmContext };
  },
};
