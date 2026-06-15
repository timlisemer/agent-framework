/**
 * Test Harness MCP — Shared utilities for labeler and tester tools.
 *
 * Pure TypeScript operations: path resolution, file I/O scoped to
 * ~/.agent-framework/test-runs/, execFileSync wrapper for replay.ts,
 * workflow state detection, and run limit enforcement.
 *
 * NO LLM calls. NO runAgent. NO Anthropic API.
 *
 * @module test-harness-shared
 */

import * as fs from "fs";
import * as path from "path";
import { execFileSync, spawn, spawnSync } from "child_process";
import {
  validateScenario,
  validateReasonMustExpectation,
} from "../../scenario/types.js";
import {
  scenariosDir,
  type ScenarioRealityValue,
  type ScenarioSource,
  type ScenarioSourceTag,
} from "../../scenario/catalog.js";
import {
  validatePredictionAnnotationShape,
  type LabelValue,
  type PredictionAnnotation,
  type RichExpectation,
} from "../../scenario/labels.js";
export { scenarioDir, scenariosDir } from "../../scenario/catalog.js";
export type { ScenarioRealityValue, ScenarioSource, ScenarioSourceTag } from "../../scenario/catalog.js";
export type { LabelValue, PredictionAnnotation, RichExpectation } from "../../scenario/labels.js";
import { runCommand } from "../../utils/command.js";
import { readFileHeadBuffer } from "../../utils/file-io.js";
import {
  runtimeRoot,
  testRunsRoot,
  testRunFile,
  transcriptRunDir as pathsTranscriptRunDir,
  transcriptLabelFile as pathsTranscriptLabelFile,
  transcriptDraftLabelFile as pathsTranscriptDraftLabelFile,
  transcriptMcpStateFile as pathsTranscriptMcpStateFile,
  scenarioJsonFile,
  scenarioLastRunFile,
  scenarioReportFile,
  sessionTranscriptPathSidecar,
} from "../../utils/paths.js";
import { activeSpec } from "../../adapter/spec.js";

// ─── Path Resolution ───────────────────────────────────────────────────────

export function testRunsDir(): string {
  return testRunsRoot();
}

/**
 * Resolve a transcript path from a session folder name.
 *
 * Session folders live at ~/.agent-framework/sessions/<project>/<sessionFolderName>/
 * and contain a transcript-path.txt sidecar pointing at the live transcript.
 *
 * The session-folder pattern is "{ts}_{hash}" (e.g. "2025-01-15-1430_abc12345").
 * Returns null if the sidecar does not exist or the referenced file is missing.
 */
export function resolveTranscriptFromSession(sessionFolderName: string): string | null {
  const sessionsRoot = path.join(runtimeRoot(), "sessions");
  // Walk all project subdirs looking for a matching session folder
  let projectDirs: string[] = [];
  try {
    projectDirs = fs.readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const projectDir of projectDirs) {
    const sessionDir = path.join(sessionsRoot, projectDir, sessionFolderName);
    const sidecarPath = sessionTranscriptPathSidecar(sessionDir);
    if (!fs.existsSync(sidecarPath)) continue;
    try {
      const transcriptPath = fs.readFileSync(sidecarPath, "utf-8").trim();
      if (transcriptPath && fs.existsSync(transcriptPath)) {
        return transcriptPath;
      }
    } catch {
      // skip
    }
  }
  return null;
}

function hostProjectDir(): string {
  return activeSpec().resolveHostContext({ cwd: process.cwd() }).projectDir;
}

export function transcriptProjectDir(): string {
  return activeSpec().projectTranscriptsDir(hostProjectDir());
}

export function transcriptRunDir(transcriptName: string): string {
  return pathsTranscriptRunDir(transcriptName);
}

export function resolveScenarioTranscriptPath(
  transcriptName: string,
  override: string | undefined,
  options: { prefer: "project" | "run" },
): string {
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`transcript_path override "${override}" does not exist`);
    }
    return override;
  }

  const sessionPath = /^\d{4}-\d{2}-\d{2}-\d{4}_[0-9a-f]+$/.test(transcriptName)
    ? resolveTranscriptFromSession(transcriptName)
    : null;
  const projectPath = (): string =>
    resolveProjectTranscriptByName(transcriptName) ??
    activeSpec().projectTranscriptFile(transcriptName, hostProjectDir());
  const runPath = path.join(transcriptRunDir(transcriptName), "transcript.jsonl");

  const candidates = options.prefer === "project"
    ? [projectPath, () => sessionPath, () => runPath]
    : [() => runPath, () => sessionPath, projectPath];
  for (const getCandidate of candidates) {
    const candidate = getCandidate();
    if (candidate && fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Transcript not found for "${transcriptName}". Check the name and try find_work. ` +
    `If the transcript lives outside the default project transcripts directory, ` +
    `pass "transcript_path" to point at the file directly, or pass the session ` +
    `folder name (e.g. "2025-01-15-1430_abc12345") to resolve via the session sidecar.`,
  );
}

function resolveProjectTranscriptByName(transcriptName: string): string | null {
  const filename = transcriptName.endsWith(".jsonl") ? transcriptName : `${transcriptName}.jsonl`;
  const matches = activeSpec().listProjectTranscripts(hostProjectDir()).filter((entry) =>
    path.basename(entry.path) === filename || entry.name === transcriptName
  );
  if (matches.length > 1) {
    throw new Error(`Multiple transcripts named "${filename}" found for this project`);
  }
  return matches[0]?.path ?? null;
}

// ─── Scoped File I/O ───────────────────────────────────────────────────────

function assertWithinTestRuns(filePath: string): void {
  const resolved = path.resolve(filePath);
  const testRunsBase = testRunsDir();
  if (!resolved.startsWith(testRunsBase)) {
    throw new Error(`Path escapes test-runs directory: ${filePath}`);
  }
}

export function readTestRunFile(transcriptName: string, filename: string): string {
  const filePath = testRunFile(transcriptName, filename);
  assertWithinTestRuns(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

export function writeTestRunFile(transcriptName: string, filename: string, content: string): string {
  const filePath = testRunFile(transcriptName, filename);
  assertWithinTestRuns(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

export function appendTestRunFile(transcriptName: string, filename: string, content: string): string {
  const filePath = testRunFile(transcriptName, filename);
  assertWithinTestRuns(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, content);
  return filePath;
}

export function readAllowedTestRunFile(
  transcriptName: string,
  filename: string,
  allowedFiles: readonly string[],
): string {
  if (!allowedFiles.includes(filename)) {
    throw new Error(`Cannot read "${filename}". Allowed files: ${allowedFiles.join(", ")}`);
  }
  return readTestRunFile(transcriptName, filename);
}

export function appendTestRunNotes(transcriptName: string, content: string): string {
  const filePath = appendTestRunFile(transcriptName, "notes_and_questions.md", content);
  const state = detectWorkflowState(transcriptName);
  return `Appended to ${filePath}` + formatStatusFooter(state);
}

export function testRunFileExists(transcriptName: string, filename: string): boolean {
  const filePath = testRunFile(transcriptName, filename);
  return fs.existsSync(filePath);
}

// ─── Replay Command Wrapper ───────────────────────────────────────────────

function getAgentFrameworkRoot(): string {
  const root = process.env.AGENT_FRAMEWORK_ROOT;
  if (!root) {
    throw new Error("AGENT_FRAMEWORK_ROOT environment variable is not set");
  }
  return root;
}


function getNpxPath(): string {
  // tsx may not be installed as a standalone binary (e.g. NixOS).
  // Use npx which is universally available to run tsx.
  try {
    return execFileSync("which", ["npx"], { encoding: "utf-8" }).trim();
  } catch {
    return "npx";
  }
}

function filterHarnessStderr(stderr: string): string {
  return stderr.split("\n").filter(
    (line) => !line.includes("fatal: not a git repository") && !line.includes("GIT_DISCOVERY_ACROSS_FILESYSTEM")
  ).join("\n");
}

export function runJustBuild(rootOverride?: string): void {
  const root = rootOverride || getAgentFrameworkRoot();
  const result = runCommand("just build 2>&1", root);
  if (result.exitCode !== 0) {
    const output = filterHarnessStderr(result.output).trim();
    throw new Error(
      `just build failed with exit code ${result.exitCode}: ` +
      `${(output || "(no output)").slice(0, 2000)}`,
    );
  }
}

/**
 * Low-level helper: spawn `npx tsx <root>/<scriptRelPath>` with args.
 * Shared by runReplayCommand and runScenarioCommand.
 */
export function runHarnessCommand(
  scriptRelPath: string,
  args: string[],
  timeoutMs: number = 600000,
  rootOverride?: string,
): string {
  const root = rootOverride || getAgentFrameworkRoot();
  const npxPath = getNpxPath();
  const scriptPath = path.join(root, scriptRelPath);
  const fullArgs = ["tsx", scriptPath, ...args];

  // Use spawnSync to capture both stdout and stderr.
  // The harness scripts print user-facing output to stderr and only
  // structured JSON / file paths to stdout.
  const result = spawnSync(npxPath, fullArgs, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: root,
    env: {
      ...process.env,
      AGENT_FRAMEWORK_ROOT: root,
    },
    maxBuffer: 10 * 1024 * 1024,
  });

  const stdout = result.stdout || "";
  // Filter git discovery noise from stderr (AGENT_FRAMEWORK_ROOT may not be a git repo)
  const stderr = filterHarnessStderr(result.stderr || "");

  // Spawn-level failure (binary not found, signal killed, timeout)
  if (result.error) {
    const errCode = (result.error as NodeJS.ErrnoException).code;
    if (errCode === "ETIMEDOUT" || (result as unknown as { killed: boolean }).killed) {
      throw new Error(
        `${scriptRelPath} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `Partial output:\n${(stderr || stdout || "(none)").slice(0, 500)}`
      );
    }
    throw new Error(`${scriptRelPath} spawn failed: ${result.error.message}`);
  }

  // Process killed by signal without error (e.g. external SIGTERM/SIGKILL)
  if (result.signal) {
    throw new Error(
      `${scriptRelPath} was killed by signal ${result.signal}. ` +
      `Partial output:\n${(stderr || stdout || "(none)").slice(0, 500)}`
    );
  }

  // Exit code 1 = test failures (valid output with failure details)
  // Exit code 2 = harness error (incomplete labels, build failure, parse error)
  // Any other non-zero = unexpected crash
  if (result.status !== null && result.status !== 0 && result.status !== 1) {
    throw new Error(
      `${scriptRelPath} exited with code ${result.status}: ` +
      `${(stderr || stdout || "(no output)").slice(0, 1000)}`
    );
  }

  const output = (stdout + (stderr ? "\n" + stderr : "")).trim();
  if (!output) {
    throw new Error(`${scriptRelPath} produced no output — command may have failed silently`);
  }

  return output;
}

/**
 * Async variant used by batch scenario runs. It preserves the sync wrapper's
 * stdout/stderr behavior while allowing multiple scenario child processes to
 * run concurrently under one batch-level MCP request.
 */
export function runHarnessCommandAsync(
  scriptRelPath: string,
  args: string[],
  timeoutMs: number = 600000,
  rootOverride?: string,
): Promise<string> {
  const root = rootOverride || getAgentFrameworkRoot();
  const npxPath = getNpxPath();
  const scriptPath = path.join(root, scriptRelPath);
  const fullArgs = ["tsx", scriptPath, ...args];

  return new Promise((resolve, reject) => {
    const child = spawn(npxPath, fullArgs, {
      cwd: root,
      env: {
        ...process.env,
        AGENT_FRAMEWORK_ROOT: root,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(() => {
        reject(
          new Error(
            `${scriptRelPath} timed out after ${Math.round(timeoutMs / 1000)}s. ` +
            `Partial output:\n${(filterHarnessStderr(stderr) || stdout || "(none)").slice(0, 500)}`
          ),
        );
      });
    }, timeoutMs);

    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish(() => {
        reject(new Error(`${scriptRelPath} spawn failed: ${error.message}`));
      });
    });
    child.on("close", (code, signal) => {
      finish(() => {
        const filteredStderr = filterHarnessStderr(stderr);
        if (signal) {
          reject(
            new Error(
              `${scriptRelPath} was killed by signal ${signal}. ` +
              `Partial output:\n${(filteredStderr || stdout || "(none)").slice(0, 500)}`
            ),
          );
          return;
        }
        if (code !== null && code !== 0 && code !== 1) {
          reject(
            new Error(
              `${scriptRelPath} exited with code ${code}: ` +
              `${(filteredStderr || stdout || "(no output)").slice(0, 1000)}`
            ),
          );
          return;
        }

        const output = (stdout + (filteredStderr ? "\n" + filteredStderr : "")).trim();
        if (!output) {
          reject(new Error(`${scriptRelPath} produced no output — command may have failed silently`));
          return;
        }
        resolve(output);
      });
    });
  });
}

export function runReplayCommand(args: string[], timeoutMs: number = 600000, rootOverride?: string): string {
  return runHarnessCommand("src/scenario/replay.ts", args, timeoutMs, rootOverride);
}

export function runScenarioCommand(args: string[], timeoutMs: number = 300000, rootOverride?: string): string {
  return runHarnessCommand("src/scenario/runner.ts", args, timeoutMs, rootOverride);
}

export function runScenarioCommandAsync(args: string[], timeoutMs: number = 300000, rootOverride?: string): Promise<string> {
  return runHarnessCommandAsync("src/scenario/runner.ts", args, timeoutMs, rootOverride);
}

// ─── Version ──────────────────────────────────────────────────────────────

import { VERSION } from "../../version.js";

export function getVersion(): string {
  return VERSION;
}

// ─── Label File Operations ─────────────────────────────────────────────────

interface LabelFile {
  _meta?: Record<string, unknown>;
  labels: Record<string, LabelValue>;
  reasoning?: Record<string, string>;
}

export function readLabelFile(transcriptName: string, draft: boolean): LabelFile {
  const filePath = draft ? pathsTranscriptDraftLabelFile(transcriptName) : pathsTranscriptLabelFile(transcriptName);
  assertWithinTestRuns(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(content);
  return {
    _meta: parsed._meta,
    labels: parsed.labels ?? parsed,
    reasoning: parsed.reasoning,
  };
}

export function writeLabelFile(transcriptName: string, draft: boolean, labelFile: LabelFile): string {
  const filePath = draft ? pathsTranscriptDraftLabelFile(transcriptName) : pathsTranscriptLabelFile(transcriptName);
  assertWithinTestRuns(filePath);
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  const output: Record<string, unknown> = {};
  if (labelFile._meta) {
    output._meta = labelFile._meta;
  }
  output.labels = labelFile.labels;
  if (labelFile.reasoning && Object.keys(labelFile.reasoning).length > 0) {
    output.reasoning = labelFile.reasoning;
  }
  fs.writeFileSync(filePath, JSON.stringify(output, null, 2) + "\n");
  return filePath;
}

export function updateSingleLabel(
  transcriptName: string,
  key: string,
  value: string,
  reasoning: string,
): LabelFile {
  const labelFile = readLabelFile(transcriptName, true);
  if (labelFile.labels[key] === undefined) {
    throw new Error(`Key "${key}" not found in labels.draft.json`);
  }
  const validToolValues = ["allow", "deny"];
  const validStopValues = ["pass", "block"];
  const validValues = key.startsWith("stop:") ? validStopValues : validToolValues;
  if (!validValues.includes(value) && value !== "INVESTIGATE") {
    throw new Error(`Invalid value "${value}" for key "${key}". Valid: ${validValues.join(", ")}`);
  }
  labelFile.labels[key] = value;
  if (!labelFile.reasoning) {
    labelFile.reasoning = {};
  }
  labelFile.reasoning[key] = reasoning;
  writeLabelFile(transcriptName, true, labelFile);
  return labelFile;
}

/**
 * Write a rich expectation (or array of them) for a key. Unlike
 * updateSingleLabel, this:
 *
 * - accepts the `by` (gate name) and `at` (truncation) fields
 * - allows a single rich object OR an array of rich objects
 * - may be used to CREATE a new key as well as update an existing one
 *
 * Intended for use cases where the heuristic-labeled string "allow" is
 * wrong and you need to assert "deny from rule X" or "allow at @105 and
 * allow at full". The legacy updateSingleLabel path is preserved so plain
 * pass/deny flips stay ergonomic.
 */
export function setRichLabel(
  transcriptName: string,
  key: string,
  expectation: RichExpectation | RichExpectation[],
  reasoning: string,
): LabelFile {
  const labelFile = readLabelFile(transcriptName, true);
  const entries = Array.isArray(expectation) ? expectation : [expectation];
  if (entries.length === 0) {
    throw new Error(`expectation must be a rich object or a non-empty array`);
  }
  const validToolValues = ["allow", "deny"];
  const validStopValues = ["pass", "block"];
  const baseValid = key.startsWith("stop:") ? validStopValues : validToolValues;
  for (const e of entries) {
    if (typeof e !== "object" || e === null) {
      throw new Error(`expectation entry must be an object, got ${JSON.stringify(e)}`);
    }
    if (!baseValid.includes(e.expected) && e.expected !== "INVESTIGATE") {
      throw new Error(
        `Invalid expected value "${e.expected}" for key "${key}". Valid: ${baseValid.join(", ")}`,
      );
    }
    if (e.by !== undefined && (typeof e.by !== "string" || e.by.length === 0)) {
      throw new Error(
        `"by" must be a non-empty string when set, got ${JSON.stringify(e.by)}`,
      );
    }
    if (
      e.at !== undefined &&
      e.at !== "full" &&
      !(typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 1)
    ) {
      throw new Error(
        `"at" must be a positive integer or "full" when set, got ${JSON.stringify(e.at)}`,
      );
    }
    if (e.reason_must !== undefined) {
      if (e.expected !== "deny" && e.expected !== "block") {
        throw new Error(
          `reason_must on key "${key}" requires expected ∈ {"deny","block"}, got ${JSON.stringify(e.expected)}`,
        );
      }
      validateReasonMustExpectation(`label "${key}"`, e.reason_must);
    }
    validatePredictionAnnotation(key, e);
  }
  labelFile.labels[key] = entries.length === 1 ? entries[0] : entries;
  if (!labelFile.reasoning) {
    labelFile.reasoning = {};
  }
  labelFile.reasoning[key] = reasoning;
  writeLabelFile(transcriptName, true, labelFile);
  return labelFile;
}

/**
 * Inline validator shared by setRichLabel and updateLabelPrediction. Enforces:
 * - prediction is allowed only when expected === "deny" AND by ∈
 *   {"prediction-block", "batch-sibling"}.
 * - verdict must be in the allowed set.
 * - too_broad requires non-empty forbidden_blocks.
 * - intent_must_contain must be a non-empty string when set.
 */
function validatePredictionAnnotation(key: string, e: RichExpectation): void {
  if (e.prediction === undefined) return;
  validatePredictionAnnotationShape(`label "${key}"`, e.expected, e.by, e.prediction);
}

/**
 * Update (or set) the `prediction` annotation on a single label entry. The
 * entry must already exist in labels.draft.json, must be a RichExpectation
 * with `expected === "deny"` AND `by ∈ {"prediction-block","batch-sibling"}`.
 * Plain string-form labels are first promoted to RichExpectation form.
 */
export function updateLabelPrediction(
  transcriptName: string,
  key: string,
  prediction: PredictionAnnotation,
  reasoning: string,
): LabelFile {
  const labelFile = readLabelFile(transcriptName, true);
  const existing = labelFile.labels[key];
  if (existing === undefined) {
    throw new Error(`Key "${key}" not found in labels.draft.json`);
  }
  // Determine the rich entry to mutate. If the existing label is a string,
  // we need to know its `by` to validate the prediction; we cannot derive
  // that from a string-only label, so reject and instruct the caller to
  // promote via set_label first.
  let target: RichExpectation;
  let arrayCarrier: RichExpectation[] | null = null;
  if (typeof existing === "string") {
    throw new Error(
      `Key "${key}" is a plain string label; promote it to a RichExpectation with by="prediction-block" (or "batch-sibling") via set_label before adding a prediction annotation`,
    );
  } else if (Array.isArray(existing)) {
    // Mutate the entry whose at === "full" if present, else the first entry.
    const fullIdx = existing.findIndex((e) => (e.at ?? "full") === "full");
    target = existing[fullIdx >= 0 ? fullIdx : 0];
    arrayCarrier = existing;
  } else {
    target = existing;
  }
  target.prediction = prediction;
  validatePredictionAnnotation(key, target);
  if (arrayCarrier) {
    labelFile.labels[key] = arrayCarrier;
  } else {
    labelFile.labels[key] = target;
  }
  if (!labelFile.reasoning) {
    labelFile.reasoning = {};
  }
  labelFile.reasoning[key] = reasoning;
  writeLabelFile(transcriptName, true, labelFile);
  return labelFile;
}

export function updateMultipleLabels(
  transcriptName: string,
  updates: Array<{ key: string; value: string; reasoning: string }>,
): LabelFile {
  const labelFile = readLabelFile(transcriptName, true);
  if (!labelFile.reasoning) {
    labelFile.reasoning = {};
  }
  for (const update of updates) {
    if (labelFile.labels[update.key] === undefined) {
      throw new Error(`Key "${update.key}" not found in labels.draft.json`);
    }
    const validToolValues = ["allow", "deny"];
    const validStopValues = ["pass", "block"];
    const validValues = update.key.startsWith("stop:") ? validStopValues : validToolValues;
    if (!validValues.includes(update.value) && update.value !== "INVESTIGATE") {
      throw new Error(`Invalid value "${update.value}" for key "${update.key}". Valid: ${validValues.join(", ")}`);
    }
    labelFile.labels[update.key] = update.value;
    labelFile.reasoning[update.key] = update.reasoning;
  }
  writeLabelFile(transcriptName, true, labelFile);
  return labelFile;
}

// ─── Run Limit Enforcement ─────────────────────────────────────────────────

interface McpState {
  generate_labels_count: number;
  scaffold_count: number;
  run_test_count: number;
  run_single_hook_count: number;
  run_single_hook_since_last_run_test: number;
}

function readMcpState(transcriptName: string): McpState {
  const defaults: McpState = { generate_labels_count: 0, scaffold_count: 0, run_test_count: 0, run_single_hook_count: 0, run_single_hook_since_last_run_test: 0 };
  try {
    const filePath = pathsTranscriptMcpStateFile(transcriptName);
    if (!fs.existsSync(filePath)) return defaults;
    const content = fs.readFileSync(filePath, "utf-8");
    return { ...defaults, ...JSON.parse(content) };
  } catch {
    return defaults;
  }
}

function writeMcpState(transcriptName: string, state: McpState): void {
  const filePath = pathsTranscriptMcpStateFile(transcriptName);
  const dirPath = path.dirname(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n");
}

export function checkAndIncrementRunLimit(transcriptName: string, action: "generate_labels" | "scaffold" | "run_test" | "run_single_hook"): void {
  const state = readMcpState(transcriptName);
  if (action === "generate_labels") {
    if (state.generate_labels_count >= 1) {
      throw new Error(
        "generate_labels has already been run for this transcript. " +
        "It costs real money and must only run once. Use list/expand/update_label for further work."
      );
    }
    state.generate_labels_count++;
  } else if (action === "scaffold") {
    if (state.scaffold_count >= 1) {
      throw new Error("scaffold has already been run for this transcript.");
    }
    state.scaffold_count++;
  } else if (action === "run_single_hook") {
    // No limit — single-hook runs are cheap and useful for iterating
    state.run_single_hook_count++;
    state.run_single_hook_since_last_run_test++;
  } else {
    if (state.run_test_count >= 5) {
      throw new Error(
        "Maximum 5 test runs reached for this transcript. " +
        "Each run costs real money. Report current status and stop."
      );
    }
    if (state.run_test_count >= 1 && state.run_single_hook_since_last_run_test === 0) {
      throw new Error(
        `run_test blocked: you have used ${state.run_test_count} of 5 full runs. ` +
        "You must call run_single_hook on failing hooks before running the full test again. " +
        "run_single_hook is cheap and does not count against the 5-run limit. " +
        "Use run_single_hook to verify your fixes, then run_test only for final regression."
      );
    }
    state.run_test_count++;
    state.run_single_hook_since_last_run_test = 0;
  }
  writeMcpState(transcriptName, state);
}

export function rollbackRunLimit(transcriptName: string, action: "generate_labels" | "scaffold" | "run_test" | "run_single_hook"): void {
  const state = readMcpState(transcriptName);
  if (action === "generate_labels" && state.generate_labels_count > 0) {
    state.generate_labels_count--;
  } else if (action === "scaffold" && state.scaffold_count > 0) {
    state.scaffold_count--;
  } else if (action === "run_single_hook" && state.run_single_hook_count > 0) {
    state.run_single_hook_count--;
    if (state.run_single_hook_since_last_run_test > 0) {
      state.run_single_hook_since_last_run_test--;
    }
  } else if (action === "run_test" && state.run_test_count > 0) {
    state.run_test_count--;
  }
  writeMcpState(transcriptName, state);
}

// ─── Workflow State Detection ──────────────────────────────────────────────

interface WorkflowState {
  transcriptName: string;
  hasDraft: boolean;
  hasLabels: boolean;
  hasReport: boolean;
  hasNotes: boolean;
  reportFailing: boolean;
  step: string;
  guidance: string;
}

export function detectWorkflowState(transcriptName: string): WorkflowState {
  const hasDraft = testRunFileExists(transcriptName, "labels.draft.json");
  const hasLabels = testRunFileExists(transcriptName, "labels.json");
  const hasReport = testRunFileExists(transcriptName, "report.json");
  const hasNotes = testRunFileExists(transcriptName, "notes_and_questions.md");

  let reportFailing = false;
  if (hasReport) {
    try {
      const report = JSON.parse(readTestRunFile(transcriptName, "report.json"));
      reportFailing = (report.failed ?? 0) > 0;
    } catch {
      reportFailing = false;
    }
  }

  let step: string;
  let guidance: string;

  if (!hasDraft && !hasLabels) {
    step = "NOT_STARTED";
    guidance = "No labels exist. Use auto_label (recommended) to create initial labels from both heuristic and hook signals.";
  } else if (hasDraft && !hasLabels) {
    step = "LABELING_IN_PROGRESS";
    guidance = "labels.draft.json exists. Review labels with list/expand, update with update_label, then finalize when ready.";
  } else if (hasLabels && !hasReport) {
    step = "READY_FOR_TESTING";
    guidance = "labels.json is finalized. Run the test harness with run_test.";
  } else if (hasLabels && hasReport && reportFailing) {
    step = "FAILING";
    guidance = "Test report has failures. Read the report, investigate hook code, fix issues, and re-run.";
  } else if (hasLabels && hasReport && !reportFailing) {
    step = "PASSING";
    guidance = "All tests pass. This transcript is done.";
  } else {
    step = "UNKNOWN";
    guidance = "Unexpected state. Check files manually.";
  }

  return { transcriptName, hasDraft, hasLabels, hasReport, hasNotes, reportFailing, step, guidance };
}

export function formatStatusFooter(state: WorkflowState): string {
  const lines = [
    "",
    "--- STATUS ---",
    `Transcript: ${state.transcriptName}`,
    `Step: ${state.step}`,
    `Files: ${[
      state.hasDraft ? "labels.draft.json" : null,
      state.hasLabels ? "labels.json" : null,
      state.hasReport ? "report.json" : null,
      state.hasNotes ? "notes_and_questions.md" : null,
    ].filter(Boolean).join(", ") || "(none)"}`,
    `Next: ${state.guidance}`,
  ];
  return lines.join("\n");
}

// ─── Transcript Discovery ──────────────────────────────────────────────────

interface TranscriptInfo {
  name: string;
  path: string;
  lines: number;
  sizeBytes: number;
}

export function findUnlabeledTranscripts(
  limit: number = 10,
  dateFrom?: string,
  dateTo?: string,
): TranscriptInfo[] {
  const results: TranscriptInfo[] = [];
  for (const { name, path: fullPath } of activeSpec().listProjectTranscripts(hostProjectDir())) {

    // Skip if already labeled
    if (testRunFileExists(name, "labels.json")) continue;
    if (testRunFileExists(name, "labels.draft.json")) continue;

    // Skip sidechain transcripts
    const head = readFileHeadBuffer(fullPath, 4096);
    if (!head) {
      continue;
    }
    const firstLine = head.toString("utf-8").split("\n")[0];
    if (firstLine.includes("\"isSidechain\"")) continue;

    try {
      const stat = fs.statSync(fullPath);

      // Date filtering based on file modification time
      if (dateFrom || dateTo) {
        const modDate = stat.mtime.toISOString().slice(0, 10);
        if (dateFrom && modDate < dateFrom) continue;
        if (dateTo && modDate > dateTo) continue;
      }

      const content = fs.readFileSync(fullPath, "utf-8");
      const lineCount = content.split("\n").filter(Boolean).length;
      results.push({ name, path: fullPath, lines: lineCount, sizeBytes: stat.size });
    } catch {
      continue;
    }
  }

  // Sort by size descending
  results.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return results.slice(0, limit);
}

export function findTestableTranscripts(): Array<{ name: string; status: "UNTESTED" | "FAILING" }> {
  const results: Array<{ name: string; status: "UNTESTED" | "FAILING" }> = [];

  if (!fs.existsSync(testRunsDir())) {
    return results;
  }

  const entries = fs.readdirSync(testRunsDir());
  for (const entry of entries) {
    const dirPath = pathsTranscriptRunDir(entry);
    try {
      const stat = fs.statSync(dirPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }

    // Must have labels.json
    if (!testRunFileExists(entry, "labels.json")) continue;

    // Check report
    if (!testRunFileExists(entry, "report.json")) {
      results.push({ name: entry, status: "UNTESTED" });
      continue;
    }

    try {
      const report = JSON.parse(readTestRunFile(entry, "report.json"));
      if ((report.failed ?? 0) > 0) {
        results.push({ name: entry, status: "FAILING" });
      }
    } catch {
      results.push({ name: entry, status: "UNTESTED" });
    }
  }

  return results;
}

// ─── Scenario Helpers ──────────────────────────────────────────────────────

const FIXTURE_SUBFOLDERS = ["expected-to-pass", "non-deterministic", "expected-to-fail"] as const;

/**
 * Absolute path to the repo-tracked fixture scenarios directory:
 *   <root>/scenarios/
 * Honors AGENT_FRAMEWORK_ROOT (or a per-call working_dir override).
 */
export function fixturesScenariosDir(rootOverride?: string): string {
  const root = rootOverride ?? process.env.AGENT_FRAMEWORK_ROOT;
  if (!root) {
    throw new Error(
      "AGENT_FRAMEWORK_ROOT (or working_dir) required to locate scenarios/",
    );
  }
  return path.join(root, "scenarios");
}

/**
 * Write a scenario object to disk at scenarios/<name>/scenario.json.
 * Caller is expected to have validated the object shape first.
 */
export function writeScenarioFile(name: string, scenario: unknown): string {
  const file = scenarioJsonFile(name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scenario, null, 2) + "\n");
  return file;
}

/**
 * Read scenario.json or report-scenario.json for a named scenario.
 * Rejects any other filename.
 */
export function readScenarioFile(name: string, filename: string): string {
  const allowed = ["scenario.json", "report-scenario.json"];
  if (!allowed.includes(filename)) {
    throw new Error(`Cannot read "${filename}". Allowed: ${allowed.join(", ")}`);
  }
  const file = filename === "scenario.json"
    ? scenarioJsonFile(name)
    : scenarioReportFile(name);
  if (!fs.existsSync(file)) {
    throw new Error(`${filename} not found for scenario "${name}" at ${file}`);
  }
  return fs.readFileSync(file, "utf-8");
}

/**
 * Describes one discoverable scenario across the four sources: home
 * (~/.agent-framework/test-runs/scenarios/<name>/scenario.json) and the
 * three repo-tracked fixture subfolders (expected-to-pass/, non-deterministic/,
 * expected-to-fail/ under <root>/scenarios/). `inputPath`
 * is what the scenario runner reads; `outputDir` is where cache/ and
 * report-scenario.json land — always under
 * ~/.agent-framework/test-runs/scenarios/<name>/ so the repo-tracked
 * fixture files never get polluted by per-run artifacts. `error` is set
 * when the fixture is malformed (filename stem does not match
 * scenario.name, or validateScenario rejects the JSON); such entries
 * must not be executed but are surfaced to the caller so the user sees
 * the broken fixture.
 */
/**
 * Enumerate every scenario discoverable across four sources: home
 * (~/.agent-framework/test-runs/scenarios/) and the three repo-tracked
 * fixture subfolders (<root>/scenarios/expected-to-pass/,
 * non-deterministic/, expected-to-fail/). Entries are sorted alphabetically by name.
 *
 * Per-fixture validation errors (filename stem != scenario.name, or
 * validateScenario rejection) are attached to the entry as `error`
 * without aborting discovery. Cross-source slug collisions (same slug
 * present in two or more of the four sources) are infrastructure bugs
 * and throw with both offending paths + source tags — the caller
 * (run_scenarios) wraps the discovery call in a try/catch and surfaces
 * that as a single <discovery> result entry.
 */
export function listAllScenarios(rootOverride?: string): ScenarioSource[] {
  const out = new Map<string, ScenarioSource>();

  const addOrCollide = (entry: ScenarioSource): void => {
    const prior = out.get(entry.name);
    if (prior) {
      throw new Error(
        `scenario slug "${entry.name}" exists in MORE THAN ONE source:\n` +
          `  ${prior.source}:   ${prior.inputPath}\n` +
          `  ${entry.source}:   ${entry.inputPath}\n` +
          `Slugs must be unique across home and all fixture subfolders. Delete one copy.`,
      );
    }
    out.set(entry.name, entry);
  };

  const scenariosBase = scenariosDir();
  if (fs.existsSync(scenariosBase)) {
    for (const entry of fs.readdirSync(scenariosBase)) {
      if (!/^[A-Za-z0-9._-]+$/.test(entry)) continue;
      const inputPath = path.join(scenariosBase, entry, "scenario.json");
      if (!fs.existsSync(inputPath)) continue;
      const outputDir = path.join(scenariosBase, entry);
      addOrCollide({
        name: entry,
        source: "home",
        inputPath,
        outputDir,
        hasReport: fs.existsSync(path.join(outputDir, "report-scenario.json")),
        lastRun: readScenarioLastRun(entry),
      });
    }
  }

  let fixRoot: string;
  try {
    fixRoot = fixturesScenariosDir(rootOverride);
  } catch {
    return sortedScenarios(out);
  }

  for (const sub of FIXTURE_SUBFOLDERS) {
    const subDir = path.join(fixRoot, sub);
    if (!fs.existsSync(subDir)) continue;
    const tag: ScenarioSourceTag = sub;

    for (const file of fs.readdirSync(subDir)) {
      if (!file.endsWith(".json")) continue;
      const name = file.slice(0, -".json".length);
      if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;

      const inputPath = path.join(subDir, file);
      const outputDir = path.join(scenariosBase, name);
      const hasReport = fs.existsSync(
        path.join(outputDir, "report-scenario.json"),
      );

      let fixtureError: string | undefined;
      try {
        const parsed = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as {
          name?: unknown;
        };
        if (parsed.name !== name) {
          fixtureError = `fixture ${inputPath}: scenario.name=${JSON.stringify(parsed.name)} must equal filename stem "${name}"`;
        } else {
          validateScenario(parsed);
        }
      } catch (err) {
        fixtureError = err instanceof Error ? err.message : String(err);
      }

      addOrCollide({
        name,
        source: tag,
        inputPath,
        outputDir,
        hasReport,
        lastRun: readScenarioLastRun(name),
        ...(fixtureError ? { error: fixtureError } : {}),
      });
    }
  }
  return sortedScenarios(out);
}

/**
 * Filter scenarios by source label.
 */
export function filterScenariosBySource(
  all: ScenarioSource[],
  filter: "expected-to-pass" | "non-deterministic" | "expected-to-fail" | "home",
): ScenarioSource[] {
  return all.filter((s) => s.source === filter);
}

function sortedScenarios(m: Map<string, ScenarioSource>): ScenarioSource[] {
  return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read last-run.json sidecar for a scenario, if it exists.
 * Returns undefined when the file is absent or malformed.
 */
function readScenarioLastRun(name: string): { reality: ScenarioRealityValue; at: string } | undefined {
  try {
    const filePath = scenarioLastRunFile(name);
    if (!fs.existsSync(filePath)) return undefined;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      reality?: unknown;
      at?: unknown;
    };
    if (typeof parsed.at !== "string") return undefined;
    const reality = parsed.reality as ScenarioRealityValue;
    return { reality, at: parsed.at };
  } catch {
    return undefined;
  }
}
