/**
 * Confirm Pre-Filter — file/extension-aware regex scanner for the confirm agent.
 *
 * Pre-computes the deterministic CONFIRM_AGENT category-1 (unwanted files) and
 * a subset of category-2 (debug code, unused-code workarounds) signals so the
 * SDK agent never has to re-derive them from the diff. The LLM is still
 * responsible for non-pattern issues (custom build dirs, semantic bugs,
 * security, docs, tests).
 *
 * @module confirm-prefilter
 */

import { isSensitivePath } from "./sensitive-paths.js";

const UNWANTED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)build\//,
  /(^|\/)out\//,
  /(^|\/)target\//,
  /(^|\/)vendor\//,
  /(^|\/)coverage\//,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$)[^/]+$/,
  /\.log$/,
  /\.tmp$/,
  /\.cache$/,
  /\.DS_Store$/,
  /Thumbs\.db$/,
  /(^|\/)__pycache__\//,
  /\.pyc$/,
  /(^|\/)\.idea\//,
];

// File-extension-scoped debug patterns. Each entry's `matchFile` predicate
// is run against the path of the diff hunk's current file; only matching
// patterns then run on `+` lines.
const DEBUG_CODE_PATTERNS: Array<{
  matchFile: (p: string) => boolean;
  patterns: { re: RegExp; label: string }[];
}> = [
  {
    matchFile: (p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p),
    patterns: [
      { re: /\bconsole\.(log|debug|info|warn)\s*\(/, label: "console.log/debug" },
      { re: /\bdebugger\b/, label: "debugger statement" },
    ],
  },
  {
    matchFile: (p) => /\.(rs)$/i.test(p),
    patterns: [{ re: /\bdbg!\s*\(/, label: "dbg!() (Rust)" }],
  },
  {
    matchFile: (p) => /\.(py)$/i.test(p),
    patterns: [{ re: /^\s*print\s*\(/, label: "print() (Python)" }],
  },
];

const UNUSED_CODE_WORKAROUNDS: { re: RegExp; label: string }[] = [
  { re: /@ts-ignore\b/, label: "@ts-ignore" },
  { re: /@ts-expect-error\b/, label: "@ts-expect-error" },
  { re: /^\s*(let|const|var|fn)\s+_\w+\s*=/, label: "_-prefixed unused var" },
  { re: /#\[allow\(dead_code\)\]/, label: "#[allow(dead_code)]" },
];

const DEDUPLICATION_USER_REQUEST_PATTERNS: RegExp[] = [
  /\bde-?duplicat(?:e|ed|es|ing|ion)\b/i,
  /\b(?:remove|avoid|prevent|fix)\s+(?:the\s+)?duplicate\s+code\b/i,
  /\b(?:reuse|use)\s+(?:the\s+)?(?:existing|shared|common)\s+(?:code|helper|utility|function|logic)\b/i,
  /\b(?:generic|reusable|shared|common)\s+(?:code|helper|utility|function|logic|abstraction)\b/i,
  /\b(?:create|extract|factor(?:\s+out)?)\s+(?:a\s+)?(?:generic|reusable|shared|common)\s+(?:helper|utility|function|logic|abstraction)\b/i,
];

export interface ConfirmPrefilterResult {
  unwantedFiles: string[];
  debugCode: { file: string; line: string; label: string }[];
  unusedCodeWorkarounds: { file: string; line: string; label: string }[];
}

/**
 * Walk diff hunks tracking the active file via `+++ b/<path>` headers. For
 * each `+` line (excluding the `+++` file marker), apply the file-extension-
 * scoped debug patterns and the language-agnostic unused-code workarounds.
 *
 * Unwanted file paths come from porcelain status (`A`/`M`/`??` lines).
 */
export function runConfirmPrefilter(
  porcelainStatus: string,
  diff: string,
): ConfirmPrefilterResult {
  const unwantedFiles: string[] = [];
  for (const line of porcelainStatus.split("\n")) {
    if (!line.trim()) continue;
    // Porcelain status: 2-char status code + space + path. Untracked uses "?? path".
    const path = line.startsWith("??") ? line.slice(3).trim() : line.slice(3).trim();
    if (!path) continue;
    if (UNWANTED_PATH_PATTERNS.some((re) => re.test(path)) || isSensitivePath(path)) {
      unwantedFiles.push(path);
    }
  }

  const debugCode: ConfirmPrefilterResult["debugCode"] = [];
  const unusedCodeWorkarounds: ConfirmPrefilterResult["unusedCodeWorkarounds"] = [];

  let activeFile = "";
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ b/")) {
      activeFile = rawLine.slice(6);
      continue;
    }
    if (rawLine.startsWith("+++ ")) {
      // e.g. `+++ /dev/null` for deletions
      activeFile = "";
      continue;
    }
    if (rawLine.startsWith("---")) continue;
    if (!rawLine.startsWith("+")) continue;
    // Strip the leading `+` to inspect the actual added line content.
    const content = rawLine.slice(1);

    if (activeFile) {
      // Strip string literals (single, double, backtick) and skip pure
      // comment lines before debug-code matching. The DEBUG_CODE_PATTERNS
      // regexes are deliberately substring matchers; without this guard a
      // backtick-quoted shell command in a test fixture or a `//` comment
      // quoting a code example produces a false positive. Mirrors the same
      // strip-then-test pattern used in src/utils/command-patterns.ts.
      // Greedy non-nested replace is sufficient for
      // the false-positive classes seen in practice; full parser-grade
      // quote handling is out of scope.
      const codeOnly = content
        .replace(/`[^`]*`/g, "")
        .replace(/"[^"]*"/g, "")
        .replace(/'[^']*'/g, "");
      const trimmed = codeOnly.trimStart();
      const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
      if (!isComment) {
        for (const { matchFile, patterns } of DEBUG_CODE_PATTERNS) {
          if (!matchFile(activeFile)) continue;
          for (const { re, label } of patterns) {
            if (re.test(codeOnly)) {
              debugCode.push({ file: activeFile, line: content.trim(), label });
            }
          }
        }
      }
    }

    for (const { re, label } of UNUSED_CODE_WORKAROUNDS) {
      if (re.test(content)) {
        unusedCodeWorkarounds.push({
          file: activeFile,
          line: content.trim(),
          label,
        });
      }
    }
  }

  return { unwantedFiles, debugCode, unusedCodeWorkarounds };
}

export function findDeduplicationUserRequirement(text: string): string | undefined {
  const lines = text.split("\n");
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DEDUPLICATION_USER_REQUEST_PATTERNS.some((re) => re.test(line))) {
      return line.replace(/^>\s*/, "");
    }
  }
  return undefined;
}

/**
 * Format a precomputed-violations block for injection into the confirm agent
 * context. Returns "" when no violations were found so callers can omit the
 * section entirely.
 */
export function formatConfirmPrefilter(r: ConfirmPrefilterResult): string {
  if (
    r.unwantedFiles.length === 0 &&
    r.debugCode.length === 0 &&
    r.unusedCodeWorkarounds.length === 0
  ) {
    return "";
  }
  const lines: string[] = ["=== PRECOMPUTED VIOLATIONS ==="];
  if (r.unwantedFiles.length > 0) {
    lines.push("Files (CATEGORY 1): the following paths match unwanted-file patterns:");
    for (const f of r.unwantedFiles) lines.push(`  - ${f}`);
  }
  if (r.debugCode.length > 0) {
    lines.push("Code Quality (CATEGORY 2 — debug code added):");
    for (const e of r.debugCode) {
      lines.push(`  - ${e.file}: ${e.label} → "${e.line.slice(0, 100)}"`);
    }
  }
  if (r.unusedCodeWorkarounds.length > 0) {
    lines.push("Code Quality (CATEGORY 2 — unused-code workarounds):");
    for (const e of r.unusedCodeWorkarounds) {
      lines.push(`  - ${e.file}: ${e.label} → "${e.line.slice(0, 100)}"`);
    }
  }
  lines.push("=== END PRECOMPUTED VIOLATIONS ===");
  return lines.join("\n") + "\n";
}
