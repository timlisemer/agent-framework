/**
 * Check Agent - Linter, Type-Check, and Supplemental Diagnostics Summarizer
 *
 * This agent runs project linters, make/just check, and narrow supplemental
 * editor diagnostics for known command-tool gaps, then summarizes the results
 * without analysis or suggestions. It classifies issues as errors, warnings,
 * or info.
 *
 * ## FLOW
 *
 * 1. Get uncommitted files info
 * 2. Detect and run project linter (ESLint, Cargo, Ruff, etc.)
 * 3. Run check target (Justfile preferred, Makefile fallback)
 * 4. Run supplemental editor diagnostics for known gaps
 * 5. Summarize results via unified runner
 *
 * ## CLASSIFICATION
 *
 * - ERRORS: Compilation failures, type errors, syntax errors, UNUSED CODE
 * - WARNINGS: Style suggestions, lints, refactoring hints
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
import { runAgent } from "../../utils/agent-runner.js";
import { CHECK_AGENT } from "../../utils/agent-configs.js";
import { runProcessCancellable } from "../../utils/command.js";
import {
  findDeletedOrRenamedFileReferenceIssuesCancellable,
  getGitStatusCancellable,
  getRepoInfoCancellable,
  sortReposWithChangesSubmodulesFirst,
  type DeletedOrRenamedFileReferenceIssue,
  type RepoInfo,
} from "../../utils/git-utils.js";
import { logAgentStarted, logAgentResult } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { isCancellationError, type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { reduceDriftDetectionWindow } from "../../scenario/lifecycle.js";
import { runSupplementalDiagnosticProviders } from "../../utils/supplemental-diagnostics.js";
import { parseCheckAgentResult } from "../../utils/check-result.js";
import { setMcpTimeoutPhase } from "../../mcp/timeout.js";

import { activeSpec, registeredAdapterNames } from "../../adapter/spec.js";
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

function clipMiddleUtf8(text: string, maxBytes: number): string {
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength <= maxBytes) return text;

  const marker = `\n[agent-framework: check context truncated from ${byteLength} to ${maxBytes} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  const keepBytes = Math.max(0, maxBytes - markerBytes);
  const headBytes = Math.floor(keepBytes * 0.65);
  const tailBytes = keepBytes - headBytes;
  const buffer = Buffer.from(text, "utf-8");
  return buffer.subarray(0, headBytes).toString("utf-8") +
    marker +
    buffer.subarray(Math.max(headBytes, buffer.length - tailBytes)).toString("utf-8");
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
  const action = issue.changeType === "deleted" ? "Deleted" : "Renamed";
  const repoLabel = includeRepoLabel ? ` in ${repo.name} (${repo.path})` : "";
  const references = issue.references
    .map((ref) => `  - ${ref.path}:${ref.line}: ${ref.text}`)
    .join("\n");
  return [
    `${action} file${repoLabel} \`${issue.oldPath}\` still has references to old filename \`${issue.oldBasename}\`:`,
    references,
  ].join("\n");
}

export function appendDeterministicCheckErrors(
  output: string,
  errors: string[],
): string {
  if (errors.length === 0) return output;

  const errMatch = output.match(/## Errors\s*\n([\s\S]*?)(?:\n## |$)/);
  const existingBody = errMatch?.[1].trim();
  const existingErrors = existingBody && existingBody !== "(none)" ? existingBody : "";
  const deterministicBody = [
    existingErrors,
    "DETERMINISTIC CHECK ERRORS:",
    ...errors,
  ].filter(Boolean).join("\n");

  let next = replaceSectionBody(output, "Errors", deterministicBody);
  const errorCount = resultCount(output, "Errors") + errors.length;
  const warningCount = resultCount(output, "Warnings");
  next = setResultCount(next, "Errors", errorCount);
  next = setResultCount(next, "Warnings", warningCount);
  return applyStatusOverride(next);
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
      const lint = await runCheckPhase(`run linter: ${linter.cmd}`, () =>
        runProcessCancellable({ shell: true, command: linter.cmd }, linter.dir, options)
      );
      const lintLocation = linter.dir === repo.path ? "" : ` (from ${path.basename(linter.dir)})`;
      const repoLabel = options.repoScope?.mode === "all" ? ` for ${repo.name}` : "";
      const section = clipCheckContextSection(`LINTER OUTPUT${repoLabel}${lintLocation} (exit code ${lint.exitCode}):\n${lint.output}`);
      lintSections.push(section);
      if (lint.exitCode !== 0) {
        commandErrors.push(section);
      }
    }
  }
  lintOutput = lintSections.length > 0 ? `${lintSections.join("\n\n")}\n` : "";

  // Step 3: Run check target (Justfile preferred, Makefile fallback)
  let checkOutput = "";
  const checkSections: string[] = [];
  const seenCheckInvocations = new Set<string>();
  for (const repo of scopedRepos) {
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
        const check = await runCheckPhase(
          `run ${invocation.type} check${invocation.adapter ? ` for ${invocation.adapter}` : ""}`,
          () => runProcessCancellable(
            { shell: true, command: invocation.cmd },
            invocation.dir,
            { ...options, env: invocation.env },
          ),
        );
        const label = invocation.type === "just" ? "JUST CHECK" : "MAKE CHECK";
        const checkLocation = invocation.dir === repo.path ? "" : ` (from ${path.basename(invocation.dir)})`;
        const adapterLabel = invocation.adapter ? ` [adapter=${invocation.adapter}]` : "";
        const repoLabel = options.repoScope?.mode === "all" ? ` for ${repo.name}` : "";
        const section = clipCheckContextSection(`${label} OUTPUT${adapterLabel}${repoLabel}${checkLocation} (exit code ${check.exitCode}):\n${check.output}`);
        checkSections.push(section);
        if (check.exitCode !== 0) {
          commandErrors.push(section);
        }
      }
    } else {
      throwIfAborted(options.signal);
      const error = "No Justfile or Makefile found. The check agent expects a Justfile with a 'check' recipe, or a Makefile with a 'check' target.";
      const section = `CHECK OUTPUT${options.repoScope?.mode === "all" ? ` for ${repo.name}` : ""}: ${error}`;
      checkSections.push(section);
      commandErrors.push(section);
    }
  }
  checkOutput = checkSections.join("\n\n");

  // Step 4: Run supplemental editor diagnostics for known command-tool gaps
  throwIfAborted(options.signal);
  const supplementalSections: string[] = [];
  for (const repo of scopedRepos) {
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

  // Deterministic deleted/renamed filename reference check. This runs outside
  // CHECK_AGENT so stale references cannot be downgraded or missed by the LLM.
  const deterministicErrors: string[] = [];
  for (const repo of scopedRepos) {
    throwIfAborted(options.signal);
    const issues = await runCheckPhase(`run deterministic filename-reference diagnostics for ${repo.name}`, () =>
      findDeletedOrRenamedFileReferenceIssuesCancellable(repo.path, options)
    );
    deterministicErrors.push(
      ...issues.map((issue) =>
        formatDeletedOrRenamedReferenceError(repo, issue, options.repoScope?.mode === "all")
      ),
    );
  }

  // Step 5: Use unified runner for analysis
  const result = await runCheckPhase(
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
      options,
    ),
  );

  const summarizerFailed =
    result.success === false ||
    (result.errorCount ?? 0) > 0 ||
    result.output.startsWith("[DIRECT ERROR]") ||
    result.output.startsWith("[SDK ERROR]");
  if (summarizerFailed) {
    const fallback = deterministicCheckFallback({
      commandErrors,
      deterministicErrors,
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
  //   2. Append deterministic TS-side errors that the LLM cannot downgrade.
  //   3. Recompute Status from the final Errors count.
  // The LLM still classifies most lines correctly; this just corrects drift.
  const promoted = promoteUnusedCodeToErrors(result.output);
  const withDeterministicErrors = appendDeterministicCheckErrors(promoted, deterministicErrors);
  const normalized = applyStatusOverride(withDeterministicErrors);

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
  supplementalOutput: string;
  rawError: string;
}): string {
  const errors = [...input.commandErrors, ...input.deterministicErrors];
  const warnings = input.supplementalOutput ? [input.supplementalOutput] : [];
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
