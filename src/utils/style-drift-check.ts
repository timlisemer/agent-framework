/** Repository-wide deterministic style checks used by the check MCP. */

import ts from "typescript";
import type { CancellationOptions } from "./cancellation.js";
import { throwIfAborted } from "./cancellation.js";
import {
  EMOJI_REGEX,
  analyzeQuotePreferences,
  type QuotePreference,
} from "./content-patterns.js";
import {
  type GitVisibleScanSkippedFile,
  scanGitVisibleTextFilesCancellable,
} from "./git-utils.js";
import { formatGitPathForContext } from "./git-status.js";
import { readValidatedTextFileCancellable } from "./file-io.js";
import { resolveHostContext } from "./host-context.js";

export const STYLE_DRIFT_IGNORE_NEXT_LINE = "agent-framework-style-drift-ignore-next-line";
export const STYLE_DRIFT_IGNORE_FILE = "agent-framework-style-drift-ignore-file";

export type StyleDriftKind =
  | "emoji"
  | "unicode-dash"
  | "quote-style"
  | "rust-lint-suppression"
  | "rust-lint-policy";

export interface StyleDriftFinding {
  path: string;
  line: number;
  column: number;
  kind: StyleDriftKind;
  message: string;
}

export interface StyleDriftScanResult {
  findings: StyleDriftFinding[];
  totalFindings: number;
  skippedFiles: GitVisibleScanSkippedFile[];
  policyWarnings: string[];
}

export type StyleDriftContentScanResult = Pick<StyleDriftScanResult, "findings" | "totalFindings">;

type ContentScanOptions = CancellationOptions & {
  quotePreference?: QuotePreference;
  maxFindings?: number;
};

const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?)$/i;
const UNICODE_DASH_RE = /[\u2013\u2014\u2015]/gu;
const SUPPRESSED_RUST_LINT_RE = /\b(?:clippy\s*::\s*[a-z0-9_]+|dead_code|unused(?:_[a-z0-9_]+)?|unreachable_code)\b/gi;
const MAX_FORMATTED_FINDINGS = 100;
const MAX_FORMATTED_SKIPPED_FILES = 20;
const STYLE_SCAN_MAX_FILE_BYTES = 2 * 1024 * 1024;

function formatStyleContextPath(value: string): string {
  return formatGitPathForContext(value).replace(/`/g, "\\`");
}

function scriptKindForPath(relativePath: string): ts.ScriptKind {
  if (/\.tsx$/i.test(relativePath)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(relativePath)) return ts.ScriptKind.JSX;
  if (/\.[cm]?js$/i.test(relativePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineStartsFor(content: string): number[] {
  const starts = [0];
  for (let index = 0; index < content.length; index++) {
    if (content.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function lineAndColumn(lineStarts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle;
    else high = middle;
  }
  return { line: low + 1, column: offset - lineStarts[low] + 1 };
}

function ignoredLines(content: string): Set<number> | "file" {
  const ignored = new Set<number>();
  const lines = content.split("\n");
  const isCommentMarker = (line: string, marker: string): boolean => {
    const trimmed = line.trimStart();
    return ["//", "#", "/*", "*", "<!--"].some((prefix) =>
      trimmed.startsWith(`${prefix} ${marker}`)
    );
  };
  for (let index = 0; index < lines.length; index++) {
    if (isCommentMarker(lines[index], STYLE_DRIFT_IGNORE_FILE)) return "file";
    if (isCommentMarker(lines[index], STYLE_DRIFT_IGNORE_NEXT_LINE)) ignored.add(index + 2);
  }
  return ignored;
}

function skipRustLiteralOrComment(content: string, start: number): number | null {
  if (content.startsWith("//", start)) {
    const newline = content.indexOf("\n", start + 2);
    return newline < 0 ? content.length : newline + 1;
  }
  if (content.startsWith("/*", start)) {
    let depth = 1;
    let index = start + 2;
    while (index < content.length && depth > 0) {
      if (content.startsWith("/*", index)) { depth += 1; index += 2; }
      else if (content.startsWith("*/", index)) { depth -= 1; index += 2; }
      else index += 1;
    }
    return index;
  }

  const raw = content.slice(start).match(/^(?:br|r)(#*)"/);
  if (raw) {
    const terminator = `"${raw[1]}`;
    const end = content.indexOf(terminator, start + raw[0].length);
    return end < 0 ? content.length : end + terminator.length;
  }

  const quoteStart = content[start] === "\""
    ? start
    : content[start] === "b" && content[start + 1] === "\"" ? start + 1 : -1;
  if (quoteStart >= 0) {
    let index = quoteStart + 1;
    while (index < content.length) {
      if (content[index] === "\\") index += 2;
      else if (content[index] === "\"") return index + 1;
      else index += 1;
    }
    return content.length;
  }

  if (content[start] === "'") {
    const charLiteral = content.slice(start).match(/^'(?:\\.|[^'\\\n])'/);
    if (charLiteral) return start + charLiteral[0].length;
  }
  return null;
}

function rustAttributeSpans(content: string): Array<{ start: number; text: string; inner: boolean; braceDepth: number }> {
  const spans: Array<{ start: number; text: string; inner: boolean; braceDepth: number }> = [];
  let index = 0;
  let braceDepth = 0;
  while (index < content.length) {
    const skipped = skipRustLiteralOrComment(content, index);
    if (skipped !== null) { index = skipped; continue; }
    if (content[index] === "{") { braceDepth += 1; index += 1; continue; }
    if (content[index] === "}") { braceDepth = Math.max(0, braceDepth - 1); index += 1; continue; }
    if (content[index] !== "#") { index += 1; continue; }
    let bracket = index + 1;
    while (/\s/.test(content[bracket] ?? "")) bracket += 1;
    const inner = content[bracket] === "!";
    if (inner) {
      bracket += 1;
      while (/\s/.test(content[bracket] ?? "")) bracket += 1;
    }
    if (content[bracket] !== "[") { index += 1; continue; }

    let cursor = bracket + 1;
    let depth = 1;
    while (cursor < content.length && depth > 0) {
      const innerSkipped = skipRustLiteralOrComment(content, cursor);
      if (innerSkipped !== null) { cursor = innerSkipped; continue; }
      if (content[cursor] === "[") depth += 1;
      else if (content[cursor] === "]") depth -= 1;
      cursor += 1;
    }
    if (depth === 0) spans.push({ start: index, text: content.slice(index, cursor), inner, braceDepth });
    index = cursor;
  }
  return spans;
}

function rustParenthesizedArguments(content: string, open: number): string | null {
  if (content[open] !== "(") return null;
  let depth = 1;
  for (let cursor = open + 1; cursor < content.length; cursor += 1) {
    if (content[cursor] === "(") depth += 1;
    else if (content[cursor] === ")" && --depth === 0) {
      return content.slice(open + 1, cursor);
    }
  }
  return null;
}

function rustDirectMetaArguments(content: string, names: readonly string[]): string[] {
  const bracket = content.indexOf("[");
  const body = bracket < 0 ? content : content.slice(bracket + 1, content.lastIndexOf("]"));
  const root = body.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*/);
  if (!root) return [];
  const rootOpen = root[0].length;
  const rootArguments = rustParenthesizedArguments(body, rootOpen);
  if (!rootArguments) return [];
  if (names.includes(root[1])) return [rootArguments];
  if (root[1] !== "cfg_attr") return [];

  const directMetas: string[] = [];
  let segmentStart = 0;
  let depth = 0;
  const segments: string[] = [];
  for (let cursor = 0; cursor <= rootArguments.length; cursor += 1) {
    const char = rootArguments[cursor];
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if ((char === "," || cursor === rootArguments.length) && depth === 0) {
      segments.push(rootArguments.slice(segmentStart, cursor));
      segmentStart = cursor + 1;
    }
  }
  for (const segment of segments.slice(1)) {
    const meta = segment.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*/);
    if (!meta || !names.includes(meta[1])) continue;
    const argumentsResult = rustParenthesizedArguments(segment, meta[0].length);
    if (argumentsResult) directMetas.push(argumentsResult);
  }
  return directMetas;
}

function maskRustLiteralsAndComments(content: string): string {
  const chunks: string[] = [];
  let cursor = 0;
  let copiedThrough = 0;
  while (cursor < content.length) {
    const skipped = skipRustLiteralOrComment(content, cursor);
    if (skipped === null) { cursor += 1; continue; }
    chunks.push(content.slice(copiedThrough, cursor), " ".repeat(skipped - cursor));
    copiedThrough = skipped;
    cursor = skipped;
  }
  chunks.push(content.slice(copiedThrough));
  return chunks.join("");
}

export function scanStyleDriftContent(
  relativePath: string,
  content: string,
  options: ContentScanOptions = {},
): StyleDriftContentScanResult {
  const ignored = ignoredLines(content);
  if (ignored === "file") return { findings: [], totalFindings: 0 };

  const starts = lineStartsFor(content);
  const findings: StyleDriftFinding[] = [];
  let totalFindings = 0;
  const maxFindings = options.maxFindings ?? MAX_FORMATTED_FINDINGS;
  const add = (offset: number, kind: StyleDriftKind, message: string): void => {
    const location = lineAndColumn(starts, offset);
    if (ignored.has(location.line)) return;
    totalFindings += 1;
    if (findings.length < maxFindings) {
      findings.push({ path: relativePath, ...location, kind, message });
    }
  };

  for (const match of content.matchAll(new RegExp(EMOJI_REGEX.source, EMOJI_REGEX.flags))) {
    throwIfAborted(options.signal);
    add(match.index, "emoji", "emoji is forbidden; use plain text");
  }
  for (const match of content.matchAll(UNICODE_DASH_RE)) {
    throwIfAborted(options.signal);
    add(match.index, "unicode-dash", "en/em dash is forbidden; use a normal hyphen (-)");
  }

  if (relativePath.endsWith(".rs")) {
    for (const attribute of rustAttributeSpans(content)) {
      throwIfAborted(options.signal);
      const maskedAttribute = maskRustLiteralsAndComments(attribute.text);
      const suppressed = rustDirectMetaArguments(maskedAttribute, ["allow", "expect"])
        .flatMap((argumentsText) =>
          [...argumentsText.matchAll(SUPPRESSED_RUST_LINT_RE)].map((match) =>
            match[0].replace(/\s*::\s*/g, "::")
          )
        );
      if (suppressed.length > 0) {
        add(
          attribute.start,
          "rust-lint-suppression",
          `Rust lint suppression for ${suppressed.join(", ")} is forbidden; fix or remove the underlying code`,
        );
      }
      const hasDisallowedTypesWarn = attribute.inner && attribute.braceDepth === 0 && rustDirectMetaArguments(maskedAttribute, ["warn"])
        .some((argumentsText) => /\bclippy\s*::\s*disallowed_types\b/.test(argumentsText));
      if (hasDisallowedTypesWarn) {
        add(
          attribute.start,
          "rust-lint-policy",
          "crate-level warn(clippy::disallowed_types) is explicitly forbidden; remove the attribute and fix disallowed types",
        );
      }
    }
  }

  if (options.quotePreference !== null && options.quotePreference !== undefined && SOURCE_FILE_RE.test(relativePath)) {
    const disallowedDelimiter = options.quotePreference === "double" ? "'" : "\"";
    const sourceFile = ts.createSourceFile(
      relativePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKindForPath(relativePath),
    );
    const pending: ts.Node[] = [sourceFile];
    let nodeCount = 0;
    while (pending.length > 0) {
      const node = pending.pop()!;
      if (++nodeCount % 256 === 0) throwIfAborted(options.signal);
      const tokenStart = node.getStart(sourceFile, false);
      if (ts.isStringLiteral(node) && content[tokenStart] === disallowedDelimiter) {
        add(
          tokenStart,
          "quote-style",
          `${options.quotePreference === "double" ? "single" : "double"}-quoted source string violates the repository's ${options.quotePreference}-quote requirement`,
        );
      }
      const children: ts.Node[] = [];
      ts.forEachChild(node, (child) => { children.push(child); });
      for (let index = children.length - 1; index >= 0; index -= 1) pending.push(children[index]);
    }
  }
  throwIfAborted(options.signal);
  return { findings, totalFindings };
}

async function repositoryQuotePreference(
  workingDir: string,
  options: CancellationOptions,
): Promise<{ preference: QuotePreference; warning?: string }> {
  const host = resolveHostContext({ projectDir: workingDir });
  const preferences = new Map<string, Exclude<QuotePreference, null>>();
  for (const instructionPath of host.instructionFiles) {
    throwIfAborted(options.signal);
    const instructions = await readValidatedTextFileCancellable(instructionPath, options);
    if (instructions === null) continue;
    const analysis = analyzeQuotePreferences(instructions);
    if (analysis.conflict) {
      return {
        preference: null,
        warning: `Conflicting quote policies in adapter instruction file: ${formatStyleContextPath(instructionPath)} requires both double and single quotes`,
      };
    }
    if (analysis.preference) preferences.set(instructionPath, analysis.preference);
  }
  const distinct = new Set(preferences.values());
  if (distinct.size > 1) {
    return {
      preference: null,
      warning: `Conflicting quote policies in adapter instruction files: ${[...preferences.entries()].map(([file, value]) => `${formatStyleContextPath(file)} requires ${value} quotes`).join("; ")}`,
    };
  }
  return { preference: distinct.values().next().value ?? null };
}

export async function findRepositoryStyleDrift(
  workingDir: string,
  options: CancellationOptions = {},
): Promise<StyleDriftScanResult> {
  const quotePolicy = await repositoryQuotePreference(workingDir, options);
  const result: StyleDriftScanResult = {
    findings: [],
    totalFindings: 0,
    skippedFiles: [],
    policyWarnings: quotePolicy.warning ? [quotePolicy.warning] : [],
  };
  const summary = await scanGitVisibleTextFilesCancellable(workingDir, (relativePath, content) => {
    const fileResult = scanStyleDriftContent(relativePath, content, {
      ...options,
      quotePreference: quotePolicy.preference,
      maxFindings: Math.max(0, MAX_FORMATTED_FINDINGS - result.findings.length),
    });
    result.findings.push(...fileResult.findings);
    result.totalFindings += fileResult.totalFindings;
  }, { ...options, maxFileBytes: STYLE_SCAN_MAX_FILE_BYTES });
  result.skippedFiles = summary.skippedFiles.filter((file) => file.reason !== "binary");
  return result;
}

export function formatRepositoryStyleDriftWarning(
  result: StyleDriftScanResult,
  repoLabel = "",
): string | null {
  if (result.totalFindings === 0 && result.skippedFiles.length === 0 && result.policyWarnings.length === 0) return null;
  const safeRepoLabel = repoLabel ? formatStyleContextPath(repoLabel) : "";
  const shown = result.findings.map((item) =>
    `${formatStyleContextPath(item.path)}${safeRepoLabel}:${item.line}:${item.column} [${item.kind}] ${item.message}`
  );
  const omitted = result.totalFindings - shown.length;
  if (omitted > 0) shown.push(`... ${omitted} additional style-drift finding(s) omitted`);
  if (result.skippedFiles.length > 0) {
    shown.push("STYLE SCAN INCOMPLETE:");
    shown.push(...result.skippedFiles.slice(0, MAX_FORMATTED_SKIPPED_FILES).map((file) =>
      `${formatStyleContextPath(file.path)} was not scanned (${file.reason}${file.bytes === undefined ? "" : `, ${file.bytes} bytes`})`
    ));
    const omittedSkippedFiles = result.skippedFiles.length - MAX_FORMATTED_SKIPPED_FILES;
    if (omittedSkippedFiles > 0) shown.push(`... ${omittedSkippedFiles} additional unscanned file(s) omitted`);
  }
  if (result.policyWarnings.length > 0) {
    shown.push("STYLE POLICY WARNINGS:", ...result.policyWarnings);
  }
  const heading = result.totalFindings > 0
    ? `Repository-wide style drift detected${safeRepoLabel} (${result.totalFindings} finding(s)):`
    : `Repository-wide style scan warnings${safeRepoLabel}:`;
  return `${heading}\n${shown.join("\n")}`;
}
