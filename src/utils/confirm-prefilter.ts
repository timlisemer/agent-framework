/**
 * Confirm Pre-Filter - file/extension-aware regex scanner for the confirm agent.
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
import {
  formatGitPathForContext,
  parsePorcelainStatusLine,
  parseUnifiedDiffDestination,
} from "./git-status.js";

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
type DeterministicPattern = { re: RegExp; label: string; candidate: string };

const DEBUG_CODE_PATTERNS: Array<{
  matchFile: (p: string) => boolean;
  patterns: DeterministicPattern[];
}> = [
  {
    matchFile: (p) => /\.(ts|tsx|js|jsx|mjs|cjs)$/i.test(p),
    patterns: [
      { re: /\bconsole\.(log|debug|info|warn)\s*\(/, label: "console.log/debug", candidate: "console.log();" },
      { re: /\bdebugger\b/, label: "debugger statement", candidate: "debugger;" },
    ],
  },
  {
    matchFile: (p) => /\.(rs)$/i.test(p),
    patterns: [{ re: /\bdbg!\s*\(/, label: "dbg!() (Rust)", candidate: "dbg!(value);" }],
  },
  {
    matchFile: (p) => /\.(py)$/i.test(p),
    patterns: [{ re: /^\s*print\s*\(/, label: "print() (Python)", candidate: "print()" }],
  },
];

const tsIgnoreLabel = ["@ts", "ignore"].join("-");
const tsExpectErrorLabel = ["@ts", "expect", "error"].join("-");
const UNUSED_CODE_WORKAROUNDS: DeterministicPattern[] = [
  { re: new RegExp(`${tsIgnoreLabel}\\b`), label: tsIgnoreLabel, candidate: `// ${tsIgnoreLabel}` },
  { re: new RegExp(`${tsExpectErrorLabel}\\b`), label: tsExpectErrorLabel, candidate: `// ${tsExpectErrorLabel}` },
  { re: /^\s*(let|const|var|fn)\s+_\w+\s*=/, label: "_-prefixed unused var", candidate: "let _unused = value;" },
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

function matchConfirmPrefilterAddedLine(
  activeFile: string,
  content: string,
): { debug: DeterministicPattern[]; unused: DeterministicPattern[] } {
  const codeOnly = content
    .replace(/`[^`]*`/g, "")
    .replace(/"[^"]*"/g, "")
    .replace(/'[^']*'/g, "");
  const trimmed = codeOnly.trimStart();
  const isComment = trimmed.startsWith("//") || trimmed.startsWith("*");
  const debug = activeFile && !isComment
    ? DEBUG_CODE_PATTERNS
      .filter(({ matchFile }) => matchFile(activeFile))
      .flatMap(({ patterns }) => patterns.filter(({ re }) => re.test(codeOnly)))
    : [];
  const unused = UNUSED_CODE_WORKAROUNDS.filter(({ re }) => re.test(codeOnly));
  return { debug, unused };
}

export function scanConfirmPrefilterAddedLine(
  activeFile: string,
  content: string,
): Pick<ConfirmPrefilterResult, "debugCode" | "unusedCodeWorkarounds"> {
  const debugCode: ConfirmPrefilterResult["debugCode"] = [];
  const unusedCodeWorkarounds: ConfirmPrefilterResult["unusedCodeWorkarounds"] = [];
  const matches = matchConfirmPrefilterAddedLine(activeFile, content);
  debugCode.push(...matches.debug.map(({ label }) => ({ file: activeFile, line: content.trim(), label })));
  unusedCodeWorkarounds.push(...matches.unused.map(({ label }) => ({ file: activeFile, line: content.trim(), label })));
  return { debugCode, unusedCodeWorkarounds };
}

/** Return compact lines that faithfully reproduce every deterministic finding. */
export function selectConfirmPrefilterCandidateLines(activeFile: string, content: string): string[] {
  const matches = matchConfirmPrefilterAddedLine(activeFile, content);
  return [...new Set([...matches.debug, ...matches.unused].map(({ candidate }) => candidate))];
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
    // Porcelain status: 2-char status code + space + path. Virtual normalized
    // renames use `R  old -> new`; evaluate the destination path.
    const parsed = parsePorcelainStatusLine(line);
    for (const path of parsed ? [parsed.path] : []) {
      if (UNWANTED_PATH_PATTERNS.some((re) => re.test(path)) || isSensitivePath(path)) {
        unwantedFiles.push(path);
      }
    }
  }

  const debugCode: ConfirmPrefilterResult["debugCode"] = [];
  const unusedCodeWorkarounds: ConfirmPrefilterResult["unusedCodeWorkarounds"] = [];

  let activeFile = "";
  for (const rawLine of diff.split("\n")) {
    if (rawLine.startsWith("+++ ")) {
      activeFile = parseUnifiedDiffDestination(rawLine) ?? "";
      continue;
    }
    if (rawLine.startsWith("---")) continue;
    if (!rawLine.startsWith("+")) continue;
    // Strip the leading `+` to inspect the actual added line content.
    const content = rawLine.slice(1);

    const findings = scanConfirmPrefilterAddedLine(activeFile, content);
    debugCode.push(...findings.debugCode);
    unusedCodeWorkarounds.push(...findings.unusedCodeWorkarounds);
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
  const appendLabeledFindings = (
    heading: string,
    findings: Array<{ file: string; line: string; label: string }>,
  ) => {
    if (findings.length === 0) return;
    lines.push(heading);
    for (const finding of findings) {
      lines.push(`  - ${formatGitPathForContext(finding.file)}: ${finding.label} → "${finding.line.slice(0, 100)}"`);
    }
  };
  if (r.unwantedFiles.length > 0) {
    lines.push("Files (CATEGORY 1): the following paths match unwanted-file patterns:");
    for (const f of r.unwantedFiles) lines.push(`  - ${formatGitPathForContext(f)}`);
  }
  appendLabeledFindings("Code Quality (CATEGORY 2 - debug code added):", r.debugCode);
  appendLabeledFindings(
    "Code Quality (CATEGORY 2 - unused-code workarounds):",
    r.unusedCodeWorkarounds,
  );
  lines.push("=== END PRECOMPUTED VIOLATIONS ===");
  return lines.join("\n") + "\n";
}
