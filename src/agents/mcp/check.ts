/**
 * Check Agent - Linter, Type-Check, and Supplemental Diagnostics Summarizer
 *
 * This agent runs project linters, make/just check, deterministic
 * filename-reference diagnostics, repository-wide style checks, and narrow
 * supplemental editor diagnostics for known command-tool gaps, then summarizes
 * the results without analysis or suggestions.
 *
 * ## FLOW
 *
 * 1. Get uncommitted files info
 * 2. Detect and run project linter (ESLint, Cargo, Ruff, etc.)
 * 3. Run check target (Justfile preferred, Makefile fallback)
 * 4. Run supplemental diagnostics, filename-reference diagnostics, and
 *    repository-wide deterministic style checks
 * 5. Summarize results via unified runner
 *
 * ## CLASSIFICATION
 *
 * - ERRORS: Compilation failures, type errors, syntax errors, UNUSED CODE
 * - WARNINGS: Style suggestions, lints, refactoring hints, docs/config
 *   references to missing files
 * - INFO: Benchmark results, performance metrics, test summaries (max 5 lines)
 *
 * Unused code is classified as ERROR because it must be deleted, not suppressed.
 *
 * ## OUTPUT FORMAT
 *
 * ```
 * ## Results
 * - Errors: <count>
 * - Warnings: <count>
 * - Status: PASS | FAIL
 *
 * ## Errors
 * <quoted errors>
 *
 * ## Warnings
 * <quoted warnings>
 *
 * ## Info
 * <important output like benchmarks, max 5 lines>
 * ```
 *
 * Status is FAIL if Errors > 0, PASS otherwise.
 *
 * @module check
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { EXECUTION_TYPES } from "../../types.js";
import { runAgent, type AgentExecutionResult } from "../../utils/agent-runner.js";
import { CHECK_AGENT } from "../../utils/agent-configs.js";
import {
  formatCommandTimeoutDuration,
  runProcessCancellable,
  type ProcessOutputLimits,
  type ProcessResult,
} from "../../utils/command.js";
import {
  findFilenameReferenceDiagnosticsCancellable,
  getGitStatusCancellable,
  getRepoInfoCancellable,
  sortReposWithChangesSubmodulesFirst,
  type DeletedOrRenamedFileReferenceIssue,
  type NonexistentFileReferenceIssue,
  type RepoInfo,
} from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import {
  isCancellationError,
  type CancellationOptions,
  throwIfAborted,
} from "../../utils/cancellation.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { reduceDriftDetectionWindow } from "../../scenario/lifecycle.js";
import { runSupplementalDiagnosticProviders } from "../../utils/supplemental-diagnostics.js";
import { parseCheckAgentResult } from "../../utils/check-result.js";
import {
  CHECK_COMMAND_TIMEOUT_MS,
  CHECK_SUMMARY_GRACE_MS,
  runWithMcpChildTimeout,
  runWithPausedMcpTimeout,
  setMcpTimeoutPhase,
} from "../../mcp/timeout.js";

import { activeSpec, registeredAdapterNames } from "../../adapter/spec.js";
import { clipUtf8Bytes } from "../../utils/text-bounds.js";
import {
  findRepositoryStyleDrift,
  formatRepositoryStyleDriftWarning,
} from "../../utils/style-drift-check.js";
function getHookName(): string { return activeSpec().mcpWireName("check"); }

type CheckRunner = { cmd: string; dir: string; type: string };
type CheckInvocation = CheckRunner & { adapter?: string; env?: NodeJS.ProcessEnv };
type CheckScope =
  | { mode: "single" }
  | { mode: "all"; repoInfo: RepoInfo };
type CheckOptions = CancellationOptions & { repoScope?: CheckScope };

/**
 * Regex matching unused-code lines emitted by linters across languages.
 * Strict superset of the original /unused|never read|declared but|not used/i
 * at the legacy "Action Required" footer (the same regex without word
 * boundaries). Adds `dead code` so Cargo/Rust dead-code lints are also
 * promoted. Word boundaries are intentional — substring matches like
 * `Reused` should NOT trigger promotion (verified harmless against linter
 * output samples).
 */
const UNUSED_CODE_RE = /\b(unused|never read|declared but|not used|dead code)\b/i;
const CHECK_CONTEXT_SECTION_MAX_BYTES = 256 * 1024;
const CHECK_CONTEXT_TOTAL_MAX_BYTES = 768 * 1024;

async function runCheckPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  setMcpTimeoutPhase(phase);
  try {
    return await fn();
  } finally {
    setMcpTimeoutPhase(undefined);
  }
}

async function runCheckCommandPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  return runCheckPhase(phase, () => runWithPausedMcpTimeout(fn));
}

function clipMiddleUtf8(text: string, maxBytes: number): string {
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength <= maxBytes) return text;

  const marker = `\n[agent-framework: check context truncated from ${byteLength} to ${maxBytes} bytes]\n`;
  return clipUtf8Bytes(text, maxBytes, marker);
}

function clipCheckContextSection(section: string): string {
  return clipMiddleUtf8(section, CHECK_CONTEXT_SECTION_MAX_BYTES);
}

function buildCheckAgentContext(input: {
  status: string;
  lintOutput: string;
  checkOutput: string;
  supplementalContext: string;
}): string {
  return clipMiddleUtf8(
    `UNCOMMITTED FILES:\n${input.status || "(none)"}\n\n${input.lintOutput}${input.checkOutput}${input.supplementalContext}`,
    CHECK_CONTEXT_TOTAL_MAX_BYTES,
  );
}

function checkCommandOptions(
  options: CancellationOptions,
  env?: NodeJS.ProcessEnv,
): ProcessOutputLimits {
  return {
    ...options,
    ...(env ? { env } : {}),
    commandTimeoutMs: CHECK_COMMAND_TIMEOUT_MS,
    preserveTailOnTruncate: true,
  };
}

function processResultDetails(result: ProcessResult): string {
  const timeoutText = result.timedOut
    ? `, timed out after ${formatCommandTimeoutDuration(result.timeoutMs ?? CHECK_COMMAND_TIMEOUT_MS)}`
    : "";
  return `exit code ${result.exitCode}${timeoutText}`;
}

function recordCheckCommandSection(input: {
  sections: string[];
  commandErrors: string[];
  header: string;
  result: ProcessResult;
}): boolean {
  const section = clipCheckContextSection(
    `${input.header} (${processResultDetails(input.result)}):\n${input.result.output}`,
  );
  input.sections.push(section);
  if (input.result.exitCode !== 0) {
    input.commandErrors.push(section);
  }
  return input.result.timedOut === true;
}

class CheckSummaryGraceTimeoutError extends Error {
  constructor() {
    super(`Check summarizer timed out after ${formatCommandTimeoutDuration(CHECK_SUMMARY_GRACE_MS)} summary grace following a command timeout.`);
    this.name = "CheckSummaryGraceTimeoutError";
  }
}

async function runWithCheckSummaryGrace<T>(
  options: CheckOptions,
  fn: (options: CheckOptions) => Promise<T>,
): Promise<T> {
  throwIfAborted(options.signal);
  return runWithMcpChildTimeout(
    options.signal,
    CHECK_SUMMARY_GRACE_MS,
    () => new CheckSummaryGraceTimeoutError(),
    (signal) => fn({ ...options, signal }),
  );
}

function checkSummaryGraceTimeoutResult(error: CheckSummaryGraceTimeoutError): AgentExecutionResult {
  return {
    output: `[DIRECT ERROR] ${error.message}`,
    latencyMs: CHECK_SUMMARY_GRACE_MS,
    modelTier: CHECK_AGENT.tier,
    modelName: "check-summary-grace-timeout",
    success: false,
    errorCount: 1,
  };
}

/**
 * Move any `## Warnings` section lines that match the unused-code regex into
 * the `## Errors` section, then recompute the `Errors:` and `Warnings:`
 * counts in the `## Results` block. Returns the rewritten output.
 *
 * The CHECK_AGENT prompt previously instructed the LLM to classify unused
 * code as ERROR; in practice the LLM occasionally left such items in
 * `## Warnings`. Promoting them deterministically here is a parity-preserving
 * correction.
 */
export function promoteUnusedCodeToErrors(output: string): string {
  // Locate section ranges by their headings. Sections end at the next
  // top-level "## " heading (any kind) or end-of-string.
  const sectionRe = /^## (Results|Errors|Warnings|Info)$/gim;
  type Section = { name: string; start: number; bodyStart: number; end: number };
  const sections: Section[] = [];
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = sectionRe.exec(output)) !== null) {
    matches.push(m);
  }
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const headingEnd = start + matches[i][0].length;
    const bodyStart = headingEnd + (output[headingEnd] === "\n" ? 1 : 0);
    const end = i + 1 < matches.length ? matches[i + 1].index : output.length;
    sections.push({
      name: matches[i][1],
      start,
      bodyStart,
      end,
    });
  }
  const errSec = sections.find((s) => s.name === "Errors");
  const warnSec = sections.find((s) => s.name === "Warnings");
  if (!warnSec) return output;

  // Split the warnings body into lines, classify, and rebuild.
  const warnBody = output.slice(warnSec.bodyStart, warnSec.end);
  const lines = warnBody.split("\n");
  const remainingWarn: string[] = [];
  const promoted: string[] = [];
  for (const line of lines) {
    if (UNUSED_CODE_RE.test(line) && line.trim().length > 0) {
      promoted.push(line);
    } else {
      remainingWarn.push(line);
    }
  }
  if (promoted.length === 0) return output;

  // Rebuild errors body: original errors + promoted lines.
  const newWarnBody = remainingWarn.join("\n");
  let newOutput = output;
  // Replace warnings body first (later in string) so indices for errors stay valid.
  newOutput =
    newOutput.slice(0, warnSec.bodyStart) +
    newWarnBody +
    newOutput.slice(warnSec.end);

  // Recompute the offset of the errors section after the warnings body change.
  // Errors section comes BEFORE warnings, so its indices are unchanged.
  if (errSec) {
    const errBody = newOutput.slice(errSec.bodyStart, errSec.end);
    const errBodyTrimmedTail = errBody.replace(/\n+$/, "");
    const sep = errBodyTrimmedTail.length > 0 ? "\n" : "";
    const newErrBody = errBodyTrimmedTail + sep + promoted.join("\n") + "\n";
    newOutput =
      newOutput.slice(0, errSec.bodyStart) +
      newErrBody +
      newOutput.slice(errSec.end);
  }

  // Recompute counts in the ## Results block. Count non-empty body lines.
  const resultsRe = /(- Errors:\s*)(\d+)/i;
  const warningsRe = /(- Warnings:\s*)(\d+)/i;
  const errorsCountM = newOutput.match(resultsRe);
  const warningsCountM = newOutput.match(warningsRe);
  if (errorsCountM) {
    const oldErrCount = parseInt(errorsCountM[2], 10) || 0;
    newOutput = newOutput.replace(
      resultsRe,
      `$1${oldErrCount + promoted.length}`,
    );
  }
  if (warningsCountM) {
    const oldWarnCount = parseInt(warningsCountM[2], 10) || 0;
    newOutput = newOutput.replace(
      warningsRe,
      `$1${Math.max(0, oldWarnCount - promoted.length)}`,
    );
  }
  return newOutput;
}

/**
 * Compute Status (PASS/FAIL) deterministically from the agent output and
 * inject it into / overwrite the existing `Status:` line. Defensive floor:
 * if the `## Errors` section has any non-empty content but `Errors:` parsed
 * to 0, the floor bumps the count to at least 1 before deciding PASS/FAIL.
 */
export function applyStatusOverride(output: string): string {
  const errMatch = output.match(/- Errors:\s*(\d+)/i);
  let errorCount = errMatch ? parseInt(errMatch[1], 10) : 0;

  // Defensive floor: if ## Errors section has non-empty body but the count
  // says 0, bump to 1. JavaScript regex does not support \Z, so we use
  // alternation: next "## " heading OR end-of-string.
  // The literal sentinel `(none)` is treated as empty -- the LLM writes it
  // when it has nothing to report; counting it as "non-empty content" would
  // flip Status to FAIL on every clean run.
  const errSecMatch = output.match(/## Errors\s*\n([\s\S]*?)(?:\n## |$)/);
  if (errSecMatch) {
    const body = errSecMatch[1].trim();
    const isEmpty = body.length === 0 || body === "(none)";
    if (!isEmpty && errorCount === 0) {
      errorCount = 1;
      output = output.replace(/(- Errors:\s*)\d+/i, `$1${errorCount}`);
    }
  }

  const status = errorCount > 0 ? "FAIL" : "PASS";
  if (/- Status:\s*(PASS|FAIL)/i.test(output)) {
    return output.replace(/(- Status:\s*)(PASS|FAIL)/i, `$1${status}`);
  }
  // Inject Status line after Warnings (or after Errors if Warnings absent).
  const insertAfterRe = /(- Warnings:\s*\d+\s*\n)/i;
  if (insertAfterRe.test(output)) {
    return output.replace(insertAfterRe, `$1- Status: ${status}\n`);
  }
  const errorsAfterRe = /(- Errors:\s*\d+\s*\n)/i;
  if (errorsAfterRe.test(output)) {
    return output.replace(errorsAfterRe, `$1- Status: ${status}\n`);
  }
  return output;
}

function countSectionBodyLines(output: string, heading: "Errors" | "Warnings"): number {
  const match = output.match(new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`));
  if (!match) return 0;
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== "(none)").length;
}

function replaceSectionBody(output: string, heading: "Errors" | "Warnings", body: string): string {
  const sectionRe = new RegExp(`(## ${heading}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (sectionRe.test(output)) {
    return output.replace(sectionRe, (_match, prefix: string) => `${prefix}${body.replace(/\n*$/, "\n")}`);
  }
  return `${output.replace(/\s*$/, "")}\n\n## ${heading}\n${body.replace(/\n*$/, "\n")}`;
}

function setResultCount(output: string, label: "Errors" | "Warnings", count: number): string {
  const countRe = new RegExp(`(- ${label}:\\s*)\\d+`, "i");
  if (countRe.test(output)) {
    return output.replace(countRe, (_match, prefix: string) => `${prefix}${count}`);
  }
  const resultsRe = /## Results\s*\n/;
  if (resultsRe.test(output)) {
    return output.replace(resultsRe, `## Results\n- ${label}: ${count}\n`);
  }
  return `## Results\n- ${label}: ${count}\n\n${output}`;
}

function resultCount(output: string, label: "Errors" | "Warnings"): number {
  const match = output.match(new RegExp(`- ${label}:\\s*(\\d+)`, "i"));
  return match ? parseInt(match[1], 10) || 0 : countSectionBodyLines(output, label);
}

function formatDeletedOrRenamedReferenceError(
  repo: { path: string; name: string },
  issue: DeletedOrRenamedFileReferenceIssue,
  includeRepoLabel: boolean,
): string {
  const target = issue.changeType === "deleted" ? "deleted file" : "old path of renamed file";
  return formatReferenceDiagnostics(repo, issue.references, includeRepoLabel, (ref, repoLabel) =>
    `\`${ref.path}\`${repoLabel}:${ref.line} still references ${target} \`${issue.oldPath}\` (old filename \`${issue.oldBasename}\`): ${ref.text}`
  );
}

function formatNonexistentFileReferenceWarning(
  repo: { path: string; name: string },
  issue: NonexistentFileReferenceIssue,
  includeRepoLabel: boolean,
): string {
  return formatReferenceDiagnostics(repo, issue.references, includeRepoLabel, (ref, repoLabel) =>
    `\`${ref.path}\`${repoLabel}:${ref.line} references missing file \`${issue.referencedPath}\`: ${ref.text}`
  );
}

function formatReferenceDiagnostics(
  repo: { path: string; name: string },
  references: readonly { path: string; line: number; text: string }[],
  includeRepoLabel: boolean,
  formatReference: (ref: { path: string; line: number; text: string }, repoLabel: string) => string,
): string {
  const repoLabel = includeRepoLabel ? ` in ${repo.name} (${repo.path})` : "";
  return references.map((ref) => formatReference(ref, repoLabel)).join("\n");
}

function appendDeterministicCheckSection(
  output: string,
  heading: "Errors" | "Warnings",
  sectionHeader: string,
  items: string[],
): string {
  if (items.length === 0) return output;

  const sectionMatch = output.match(new RegExp(`## ${heading}\\s*\\n([\\s\\S]*?)(?:\\n## |$)`));
  const existingBody = sectionMatch?.[1].trim();
  const existingItems = existingBody && existingBody !== "(none)" ? existingBody : "";
  const deterministicBody = [
    existingItems,
    sectionHeader,
    ...items,
  ].filter(Boolean).join("\n");

  let next = replaceSectionBody(output, heading, deterministicBody);
  const errorCount = resultCount(output, "Errors") + (heading === "Errors" ? items.length : 0);
  const warningCount = resultCount(output, "Warnings") + (heading === "Warnings" ? items.length : 0);
  next = setResultCount(next, "Errors", errorCount);
  next = setResultCount(next, "Warnings", warningCount);
  return applyStatusOverride(next);
}

export function appendDeterministicCheckErrors(
  output: string,
  errors: string[],
): string {
  return appendDeterministicCheckSection(
    output,
    "Errors",
    "DETERMINISTIC CHECK ERRORS:",
    errors,
  );
}

export function appendDeterministicCheckWarnings(
  output: string,
  warnings: string[],
): string {
  return appendDeterministicCheckSection(
    output,
    "Warnings",
    "DETERMINISTIC CHECK WARNINGS:",
    warnings,
  );
}

/**
 * Check if a command is available on the system.
 * Uses `where` on Windows and `command -v` on Unix/macOS.
 */
function isCommandAvailable(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd}` : `command -v ${cmd}`;
    execSync(check, { stdio: ["pipe", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function lintScriptCommand(dir: string): string | null {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as {
      scripts?: Record<string, unknown>;
    };
    const lintScript = packageJson.scripts?.lint;
    if (
      typeof lintScript === "string" &&
      /\beslint\b/.test(lintScript) &&
      !/\b--fix\b/.test(lintScript)
    ) {
      return "npm run lint 2>&1";
    }
  } catch {
    return null;
  }

  return null;
}

function detectLinterInDir(dir: string): { cmd: string; dir: string } | null {
  const eslintFiles = [
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.cjs",
    ".eslintrc.js",
    ".eslintrc.json",
    ".eslintrc.yml",
    ".eslintrc",
  ];
  if (eslintFiles.some((file) => fs.existsSync(path.join(dir, file)))) {
    return { cmd: lintScriptCommand(dir) ?? "npx eslint . 2>&1", dir };
  }

  const checks = [
    { files: ["Cargo.toml"], cmd: "cargo clippy 2>&1 || cargo check 2>&1" },
    {
      files: ["pyproject.toml", "setup.py"],
      cmd: "ruff check . 2>&1 || pylint . 2>&1",
    },
    {
      files: ["go.mod"],
      cmd: "golangci-lint run 2>&1 || go vet ./... 2>&1",
    },
  ];

  for (const { files, cmd } of checks) {
    for (const file of files) {
      if (fs.existsSync(path.join(dir, file))) {
        return { cmd, dir };
      }
    }
  }

  return null;
}

/**
 * Detect which linter is configured for the project.
 * Checks the target directory first, then falls back to the main repo.
 *
 * @returns Object with cmd and the directory to run it in, or null if no linter found
 */
function detectLinter(
  workingDir: string,
  mainRepo: string
): { cmd: string; dir: string } | null {
  const workingDirLinter = detectLinterInDir(workingDir);
  if (workingDirLinter) return workingDirLinter;

  // Fall back to main repo if different
  if (mainRepo !== workingDir) {
    return detectLinterInDir(mainRepo);
  }

  return null;
}

/**
 * Find a Justfile or Makefile with a check target.
 * Prefers Justfile over Makefile. Checks target directory first, then main repo.
 * Verifies that the required tool (just/make) is installed on the system.
 *
 * @returns Object with cmd/dir/type, or object with error string, or null if no file found
 */
function findCheckRunner(
  workingDir: string,
  mainRepo: string
): CheckRunner | { error: string } | null {
  const runners = [
    { file: "justfile", cmd: "just check 2>&1", type: "just", tool: "just" },
    { file: "Justfile", cmd: "just check 2>&1", type: "just", tool: "just" },
    { file: "Makefile", cmd: "make check 2>&1", type: "make", tool: "make" },
  ];

  const dirs = mainRepo !== workingDir ? [workingDir, mainRepo] : [workingDir];

  for (const dir of dirs) {
    for (const { file, cmd, type, tool } of runners) {
      if (fs.existsSync(path.join(dir, file))) {
        if (!isCommandAvailable(tool)) {
          return { error: `Found ${file} in ${dir} but '${tool}' is not installed. Please install '${tool}' to run checks.` };
        }
        return { cmd, dir, type };
      }
    }
  }

  return null;
}

function isAgentFrameworkRepo(dir: string): boolean {
  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) return false;

  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as { name?: unknown };
    return packageJson.name === "agent-framework" && fs.existsSync(path.join(dir, "src", "adapter", "spec.ts"));
  } catch {
    return false;
  }
}

export function checkInvocationsForRunner(checkRunner: CheckRunner): CheckInvocation[] {
  if (checkRunner.type !== "just" || !isAgentFrameworkRepo(checkRunner.dir)) {
    return [checkRunner];
  }

  return registeredAdapterNames().map((adapter) => ({
    ...checkRunner,
    adapter,
    env: { AGENT_FRAMEWORK_ADAPTER: adapter },
  }));
}

/**
 * Run the check agent to summarize linter, type-check, and supplemental diagnostics results.
 *
 * @param workingDir - The project directory to check
 * @param transcriptPath - Optional transcript path for statusLine updates
 * @returns Structured summary with errors, warnings, and status
 */
export async function runCheckAgent(
  workingDir: string,
  transcriptPath?: string,
  options: CheckOptions = {}
): Promise<string> {
  // Set up execution context for statusLine logging
  if (transcriptPath) {
    setTranscriptPath(transcriptPath);
  }
  logAgentStarted("check", getHookName());

  try {
    await runCheckPhase("check drift-window setup", async () => {
      const sessionDir = transcriptPath
        ? getAgentFrameworkSessionDir({ transcriptPath })
        : getAgentFrameworkSessionDir({ projectDir: workingDir });
      await reduceDriftDetectionWindow(sessionDir, 3);
    });
  } catch (error) {
    if (options.signal?.aborted || isCancellationError(error)) throw error;
    // Best-effort: check output must remain the authoritative result.
  }

  // Get main repo path for fallback
  const repoInfo = await runCheckPhase("check git repository scope", async () =>
    options.repoScope?.mode === "all"
      ? options.repoScope.repoInfo
      : await getRepoInfoCancellable(workingDir, options)
  );
  const mainRepo = repoInfo.mainRepo;
  const scopedRepos = options.repoScope?.mode === "all"
    ? sortReposWithChangesSubmodulesFirst(repoInfo)
    : [{ path: workingDir, name: path.basename(workingDir) }];

  // Step 1: Get uncommitted files info
  let status = "";
  if (options.repoScope?.mode === "all") {
    const statusSections: string[] = [];
    for (const repo of scopedRepos) {
      throwIfAborted(options.signal);
      const repoStatus = await runCheckPhase(`check git status for ${repo.name}`, () =>
        getGitStatusCancellable(repo.path, options)
      );
      statusSections.push(`=== ${repo.name} (${repo.path}) ===\n${repoStatus || "(none)"}`);
    }
    status = statusSections.join("\n\n");
  } else {
    status = await runCheckPhase("check git status", () =>
      getGitStatusCancellable(workingDir, options)
    );
  }

  // Step 2: Run linter if configured (check workingDir first, then main repo)
  let lintOutput = "";
  const lintSections: string[] = [];
  const commandErrors: string[] = [];
  let commandTimedOut = false;
  const seenLintInvocations = new Set<string>();
  for (const repo of scopedRepos) {
    const linter = detectLinter(repo.path, mainRepo);
    if (linter) {
      const lintKey = `${linter.dir}\0${linter.cmd}`;
      if (seenLintInvocations.has(lintKey)) {
        continue;
      }
      seenLintInvocations.add(lintKey);
      throwIfAborted(options.signal);
      const lint = await runCheckCommandPhase(`run linter: ${linter.cmd}`, () =>
        runProcessCancellable(
          { shell: true, command: linter.cmd },
          linter.dir,
          checkCommandOptions(options),
        )
      );
      const lintLocation = linter.dir === repo.path ? "" : ` (from ${path.basename(linter.dir)})`;
      const repoLabel = options.repoScope?.mode === "all" ? ` for ${repo.name}` : "";
      if (recordCheckCommandSection({
        sections: lintSections,
        commandErrors,
        header: `LINTER OUTPUT${repoLabel}${lintLocation}`,
        result: lint,
      })) {
        commandTimedOut = true;
        break;
      }
    }
  }
  lintOutput = lintSections.length > 0 ? `${lintSections.join("\n\n")}\n` : "";

  // Step 3: Run check target (Justfile preferred, Makefile fallback)
  let checkOutput = "";
  const checkSections: string[] = [];
  const seenCheckInvocations = new Set<string>();
  for (const repo of commandTimedOut ? [] : scopedRepos) {
    const checkRunner = findCheckRunner(repo.path, mainRepo);
    if (checkRunner && "error" in checkRunner) {
      const section = `CHECK OUTPUT${options.repoScope?.mode === "all" ? ` for ${repo.name}` : ""}: ${checkRunner.error}`;
      checkSections.push(section);
      commandErrors.push(section);
    } else if (checkRunner) {
      for (const invocation of checkInvocationsForRunner(checkRunner)) {
        const envKey = invocation.adapter ? `adapter=${invocation.adapter}` : "";
        const checkKey = `${invocation.dir}\0${invocation.cmd}\0${envKey}`;
        if (seenCheckInvocations.has(checkKey)) {
          continue;
        }
        seenCheckInvocations.add(checkKey);
        throwIfAborted(options.signal);
        const check = await runCheckCommandPhase(
          `run ${invocation.type} check${invocation.adapter ? ` for ${invocation.adapter}` : ""}`,
          () => runProcessCancellable(
            { shell: true, command: invocation.cmd },
            invocation.dir,
            checkCommandOptions(options, invocation.env),
          ),
        );
        const label = invocation.type === "just" ? "JUST CHECK" : "MAKE CHECK";
        const checkLocation = invocation.dir === repo.path ? "" : ` (from ${path.basename(invocation.dir)})`;
        const adapterLabel = invocation.adapter ? ` [adapter=${invocation.adapter}]` : "";
        const repoLabel = options.repoScope?.mode === "all" ? ` for ${repo.name}` : "";
        if (recordCheckCommandSection({
          sections: checkSections,
          commandErrors,
          header: `${label} OUTPUT${adapterLabel}${repoLabel}${checkLocation}`,
          result: check,
        })) {
          commandTimedOut = true;
          break;
        }
      }
    } else {
      throwIfAborted(options.signal);
      const error = "No Justfile or Makefile found. The check agent expects a Justfile with a 'check' recipe, or a Makefile with a 'check' target.";
      const section = `CHECK OUTPUT${options.repoScope?.mode === "all" ? ` for ${repo.name}` : ""}: ${error}`;
      checkSections.push(section);
      commandErrors.push(section);
    }
    if (commandTimedOut) break;
  }
  checkOutput = checkSections.join("\n\n");

  // Step 4: Run supplemental editor diagnostics for known command-tool gaps
  throwIfAborted(options.signal);
  const supplementalSections: string[] = [];
  for (const repo of commandTimedOut ? [] : scopedRepos) {
    throwIfAborted(options.signal);
    const supplementalOutput = await runCheckPhase(`run supplemental diagnostics for ${repo.name}`, () =>
      runSupplementalDiagnosticProviders(repo.path, options)
    );
    if (supplementalOutput) {
      const section = options.repoScope?.mode === "all"
        ? `SUPPLEMENTAL DIAGNOSTICS for ${repo.name} (${repo.path}):\n${supplementalOutput}`
        : supplementalOutput;
      supplementalSections.push(clipCheckContextSection(section));
    }
  }
  const supplementalOutput = supplementalSections.join("\n\n");
  const supplementalContext = supplementalOutput ? `\n\n${supplementalOutput}` : "";

  // Deterministic filename-reference checks run outside CHECK_AGENT so stale
  // git-deleted/renamed references cannot be downgraded or missed by the LLM,
  // and broader docs/config missing-file references remain TS-owned warnings.
  const deterministicErrors: string[] = [];
  const deterministicWarnings: string[] = [];
  for (const repo of commandTimedOut ? [] : scopedRepos) {
    throwIfAborted(options.signal);
    const diagnostics = await runCheckPhase(`run deterministic filename-reference diagnostics for ${repo.name}`, () =>
      findFilenameReferenceDiagnosticsCancellable(repo.path, options)
    );
    deterministicErrors.push(
      ...diagnostics.deletedOrRenamedIssues.map((issue) =>
        formatDeletedOrRenamedReferenceError(repo, issue, options.repoScope?.mode === "all")
      ),
    );
    deterministicWarnings.push(
      ...diagnostics.nonexistentIssues.map((issue) =>
        formatNonexistentFileReferenceWarning(repo, issue, options.repoScope?.mode === "all")
      ),
    );
  }
  // Style drift is repository state, not command output. Scan it even when a
  // linter/check command timed out so the deterministic warning is not lost.
  for (const repo of scopedRepos) {
    throwIfAborted(options.signal);
    const styleFindings = await runCheckPhase(`run deterministic style checks for ${repo.name}`, () =>
      findRepositoryStyleDrift(repo.path, options)
    );
    const styleWarning = formatRepositoryStyleDriftWarning(
      styleFindings,
      options.repoScope?.mode === "all" ? ` in ${repo.name} (${repo.path})` : "",
    );
    if (styleWarning) deterministicWarnings.push(styleWarning);
  }

  // Step 5: Use unified runner for analysis
  const summarizeCheckOutput = (summaryOptions: CheckOptions) => runCheckPhase(
    "summarize check output",
    () => runAgent(
      { ...CHECK_AGENT, workingDir },
      {
        prompt: "Summarize the following check results:",
        context: buildCheckAgentContext({
          status,
          lintOutput,
          checkOutput,
          supplementalContext,
        }),
      },
      summaryOptions,
    ),
  );

  let result: AgentExecutionResult;
  try {
    result = commandTimedOut
      ? await runWithCheckSummaryGrace(options, summarizeCheckOutput)
      : await summarizeCheckOutput(options);
  } catch (error) {
    if (error instanceof CheckSummaryGraceTimeoutError) {
      result = checkSummaryGraceTimeoutResult(error);
    } else {
      throw error;
    }
  }

  const summarizerFailed =
    result.success === false ||
    (result.errorCount ?? 0) > 0 ||
    result.output.startsWith("[DIRECT ERROR]") ||
    result.output.startsWith("[SDK ERROR]");
  if (summarizerFailed) {
    const fallback = deterministicCheckFallback({
      commandErrors,
      deterministicErrors,
      deterministicWarnings,
      supplementalOutput,
      rawError: result.output,
    });
    const isPassing = parseCheckAgentResult(fallback).status === "PASS";
    logAgentResult(result, {
      agent: "check",
      hookName: getHookName(),
      toolName: getHookName(),
      workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: isPassing ? "CONFIRM" : "DENY",
      decisionReason: isPassing ? "All checks passed" : "Checks failed",
    });
    return fallback;
  }

  // TS post-parse normalization:
  //   1. Move unused-code lines from ## Warnings into ## Errors (recompute counts).
  //   2. Append command failures and deterministic TS-side errors that the LLM
  //      cannot downgrade or miss after context clipping.
  //   3. Recompute Status from the final Errors count.
  // The LLM still classifies most lines correctly; this just corrects drift.
  const promoted = promoteUnusedCodeToErrors(result.output);
  const withDeterministicErrors = appendDeterministicCheckErrors(promoted, [
    ...commandErrors,
    ...deterministicErrors,
  ]);
  const withDeterministicWarnings = appendDeterministicCheckWarnings(
    withDeterministicErrors,
    deterministicWarnings,
  );
  const normalized = applyStatusOverride(withDeterministicWarnings);

  // Determine pass/fail status from the TS-authoritative output
  const isPassing = parseCheckAgentResult(normalized).status === "PASS";

  logAgentResult(result, {
    agent: "check",
    hookName: getHookName(),
    toolName: getHookName(),
    workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: "CONFIRM",
    decisionReason: isPassing ? "All checks passed" : "Checks failed",
  });

  // Step 6: Add guidance for unused code errors. Run the regex on the
  // normalized output so the footer fires for promoted lines too.
  const hasUnusedCode = UNUSED_CODE_RE.test(normalized);
  if (hasUnusedCode && /- Status:\s*FAIL/i.test(normalized)) {
    return `${normalized}

## Action Required
If you introduced this unused code, investigate why it happened and delete it. We do not accept unused code - it must be removed, not suppressed with underscores, @ts-ignore, or comments.`;
  }

  return normalized;
}

function deterministicCheckFallback(input: {
  commandErrors: readonly string[];
  deterministicErrors: readonly string[];
  deterministicWarnings: readonly string[];
  supplementalOutput: string;
  rawError: string;
}): string {
  const errors = [...input.commandErrors, ...input.deterministicErrors];
  const warnings = [
    ...input.deterministicWarnings,
    ...(input.supplementalOutput ? [input.supplementalOutput] : []),
  ];
  const info = [
    "Check summarizer failed or returned malformed output; using deterministic command exit-code fallback.",
    input.rawError,
  ];
  return `## Results
- Errors: ${errors.length}
- Warnings: ${warnings.length}
- Status: ${errors.length > 0 ? "FAIL" : "PASS"}

## Errors
${errors.length > 0 ? errors.join("\n") : "(none)"}

## Warnings
${warnings.length > 0 ? warnings.join("\n") : "(none)"}

## Info
${info.join("\n")}`;
}
