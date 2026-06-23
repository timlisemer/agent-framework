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
  type StyleChange,
} from "../utils/content-patterns.js";
import { STYLE_DRIFT_PROMPT_SECTION } from "../utils/agent-configs.js";
import { activeSpec } from "../adapter/spec.js";
import {
  isReplacementTextEditToolName,
  textEditReplacements,
  type TextEditReplacement,
} from "../utils/edit-tools.js";

function styleDriftEdits(toolName: string, input: unknown): TextEditReplacement[] | null {
  return isReplacementTextEditToolName(toolName)
    ? textEditReplacements(toolName, input)
    : null;
}

type StyleDriftClassification =
  | { kind: "none" }
  | { kind: "deny"; reason: string }
  | { kind: "ambiguous"; styleChanges: StyleChange[]; edit: TextEditReplacement };

function classifyStyleDriftEdit(edit: TextEditReplacement): StyleDriftClassification {
  const { old_string, new_string } = edit;

  // Pure insertion or deletion — not a style drift scenario
  if (!old_string.trim()) return { kind: "none" };
  if (!new_string.trim()) return { kind: "none" };

  // Fast-path: Detect emoji additions (always deny, even in mixed changes)
  const addedEmojis = detectEmojiAddition(old_string, new_string);
  if (addedEmojis.length > 0) {
    return { kind: "deny", reason: `emoji added (${addedEmojis.join(", ")}) - remove emoji` };
  }

  // Detect style changes with preference flags (default: double quotes)
  const styleChanges = detectStyleChanges(old_string, new_string, "double");

  // Fast-path: Emdash present in new content → deny
  const emdashChanges = styleChanges.filter((c) => c.type === "emdash");
  if (emdashChanges.length > 0) {
    return { kind: "deny", reason: "emdash detected - replace with normal dash (-)" };
  }

  // Fast-path: Backtick-only additions → deny (cosmetic formatting, not requested)
  const backtickChanges = styleChanges.filter((c) => c.type === "backtick");
  const nonBacktickChanges = styleChanges.filter((c) => c.type !== "backtick");
  if (
    nonBacktickChanges.length === 0 &&
    backtickChanges.length > 0 &&
    backtickChanges.every((c) => c.direction === "added")
  ) {
    return { kind: "deny", reason: "backticks added (cosmetic formatting) - remove backticks" };
  }

  // Fast-path: No style changes detected → pass (no LLM needed)
  if (styleChanges.length === 0) return { kind: "none" };

  // Separate quote and non-quote changes
  const quoteChanges = styleChanges.filter((c) => c.type === "quote");
  const nonQuoteChanges = styleChanges.filter((c) => c.type !== "quote");

  // Fast-path: Only quote changes away from preference → deny
  if (nonQuoteChanges.length === 0 && quoteChanges.some((c) => c.violatesPreference)) {
    return { kind: "deny", reason: "quote style changed away from preference - use double quotes" };
  }

  // Fast-path: Only quote changes toward preference → pass (no LLM needed)
  if (
    nonQuoteChanges.length === 0 &&
    quoteChanges.length > 0 &&
    quoteChanges.every((c) => c.matchesPreference)
  ) {
    return { kind: "none" };
  }

  return { kind: "ambiguous", styleChanges, edit };
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
    if (!isReplacementTextEditToolName(ctx.toolName)) {
      return null;
    }

    const eligibleFilePaths = extractFilePaths(ctx.toolName, ctx.toolInput).filter((filePath) =>
      isTrustedPath(filePath, ctx.projectDir) && !isSensitivePath(filePath)
    );

    if (eligibleFilePaths.length === 0) {
      return null;
    }

    const edits = styleDriftEdits(ctx.toolName, ctx.toolInput);
    if (!edits) return null;

    const ambiguous: Extract<StyleDriftClassification, { kind: "ambiguous" }>[] = [];
    for (const edit of edits) {
      const classification = classifyStyleDriftEdit(edit);
      if (classification.kind === "deny") return { fastDeny: classification.reason };
      if (classification.kind === "ambiguous") ambiguous.push(classification);
    }

    if (ambiguous.length === 0) return null;

    // Residual ambiguous case (semicolon / trailing-comma / mixed) → llmContext
    const hintSection = formatStyleHints(ambiguous.flatMap((classification) => classification.styleChanges));

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

    const llmContext =
      `${hintSection}\n` +
      `STYLE PREFERENCES (from ${host.instructionLabel}):\n${stylePreferences || "Default: double quotes, follow existing file conventions"}\n\n` +
      `RECENT USER MESSAGES:\n${userMessages || "No user messages available"}\n\n` +
      `EDIT DETAILS:\nFile: ${eligibleFilePaths.join(", ")}\n\n` +
      ambiguous.map((classification, index) => formatAmbiguousEdit(classification.edit, index)).join("\n\n");

    return { llmContext };
  },
};

function formatAmbiguousEdit(edit: TextEditReplacement, index: number): string {
  const MAX_CONTENT_LENGTH = 2000;
  const truncatedOld =
    edit.old_string.length > MAX_CONTENT_LENGTH
      ? edit.old_string.slice(0, MAX_CONTENT_LENGTH) + "\n... (truncated)"
      : edit.old_string;
  const truncatedNew =
    edit.new_string.length > MAX_CONTENT_LENGTH
      ? edit.new_string.slice(0, MAX_CONTENT_LENGTH) + "\n... (truncated)"
      : edit.new_string;

  return `Edit ${index + 1}:\n` +
    `Old content:\n\`\`\`\n${truncatedOld}\n\`\`\`\n\n` +
    `New content:\n\`\`\`\n${truncatedNew}\n\`\`\``;
}
