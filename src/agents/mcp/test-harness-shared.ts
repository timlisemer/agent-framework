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
import * as os from "os";
import { execFileSync, spawnSync } from "child_process";
import { validateScenario } from "./scenario-types.js";

const TEST_RUNS_DIR = path.join(os.homedir(), ".agent-framework", "test-runs");

const TRANSCRIPT_PROJECT_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "-home-tim-Coding-public-repos-agent-framework"
);

// ─── Path Resolution ───────────────────────────────────────────────────────

export function testRunsDir(): string {
  return TEST_RUNS_DIR;
}

export function transcriptProjectDir(): string {
  return TRANSCRIPT_PROJECT_DIR;
}

export function transcriptRunDir(transcriptName: string): string {
  return path.join(TEST_RUNS_DIR, transcriptName);
}

// ─── Scoped File I/O ───────────────────────────────────────────────────────

function assertWithinTestRuns(filePath: string): void {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(TEST_RUNS_DIR)) {
    throw new Error(`Path escapes test-runs directory: ${filePath}`);
  }
}

export function readTestRunFile(transcriptName: string, filename: string): string {
  const filePath = path.join(TEST_RUNS_DIR, transcriptName, filename);
  assertWithinTestRuns(filePath);
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

export function writeTestRunFile(transcriptName: string, filename: string, content: string): string {
  const dirPath = path.join(TEST_RUNS_DIR, transcriptName);
  const filePath = path.join(dirPath, filename);
  assertWithinTestRuns(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

export function appendTestRunFile(transcriptName: string, filename: string, content: string): string {
  const dirPath = path.join(TEST_RUNS_DIR, transcriptName);
  const filePath = path.join(dirPath, filename);
  assertWithinTestRuns(filePath);
  fs.mkdirSync(dirPath, { recursive: true });
  fs.appendFileSync(filePath, content);
  return filePath;
}

export function testRunFileExists(transcriptName: string, filename: string): boolean {
  const filePath = path.join(TEST_RUNS_DIR, transcriptName, filename);
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
  const stderr = (result.stderr || "").split("\n").filter(
    (line) => !line.includes("fatal: not a git repository") && !line.includes("GIT_DISCOVERY_ACROSS_FILESYSTEM")
  ).join("\n");

  // Spawn-level failure (binary not found, signal killed, timeout)
  if (result.error) {
    if ((result as unknown as { killed: boolean }).killed) {
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

export function runReplayCommand(args: string[], timeoutMs: number = 600000, rootOverride?: string): string {
  return runHarnessCommand("test-harness/replay.ts", args, timeoutMs, rootOverride);
}

export function runScenarioCommand(args: string[], timeoutMs: number = 300000, rootOverride?: string): string {
  return runHarnessCommand("test-harness/scenario.ts", args, timeoutMs, rootOverride);
}

// ─── Version ──────────────────────────────────────────────────────────────

import { VERSION } from "../../version.js";

export function getVersion(): string {
  return VERSION;
}

// ─── Label File Operations ─────────────────────────────────────────────────

/**
 * Hindsight verdict on a prediction that fired and produced a deny.
 * Mirrors test-harness/lib/types.ts:PredictionAnnotation.
 */
export interface PredictionAnnotation {
  verdict: "correct" | "too_broad" | "wrong" | "INVESTIGATE";
  forbidden_blocks?: Array<{ tool?: string; target_pattern?: string }>;
  intent_must_contain?: string;
  expected_mood?: "angry" | "frustrated" | "neutral" | "satisfied" | "happy";
  expected_trust?: "low" | "normal" | "high";
  notes?: string;
}

/**
 * A rich expectation entry with optional rule match and truncation target.
 * Mirrors test-harness/lib/types.ts:RichExpectation so shared callers do
 * not need to import from the test-harness package.
 *
 * `prediction` is set ONLY when `expected === "deny"` AND
 * `by ∈ {"prediction-block", "batch-sibling"}`.
 */
export interface RichExpectation {
  expected: string;
  by?: string;
  at?: number | "full";
  notes?: string;
  prediction?: PredictionAnnotation;
}

/**
 * A label value may be a legacy string, a rich object, or an array of
 * rich objects (for scoring the same hook under multiple truncation
 * states). The on-disk labels.json is tolerant of all three forms.
 */
export type LabelValue = string | RichExpectation | RichExpectation[];

interface LabelFile {
  _meta?: Record<string, unknown>;
  labels: Record<string, LabelValue>;
  reasoning?: Record<string, string>;
}

export function readLabelFile(transcriptName: string, draft: boolean): LabelFile {
  const filename = draft ? "labels.draft.json" : "labels.json";
  const content = readTestRunFile(transcriptName, filename);
  const parsed = JSON.parse(content);
  return {
    _meta: parsed._meta,
    labels: parsed.labels ?? parsed,
    reasoning: parsed.reasoning,
  };
}

export function writeLabelFile(transcriptName: string, draft: boolean, labelFile: LabelFile): string {
  const filename = draft ? "labels.draft.json" : "labels.json";
  const output: Record<string, unknown> = {};
  if (labelFile._meta) {
    output._meta = labelFile._meta;
  }
  output.labels = labelFile.labels;
  if (labelFile.reasoning && Object.keys(labelFile.reasoning).length > 0) {
    output.reasoning = labelFile.reasoning;
  }
  return writeTestRunFile(transcriptName, filename, JSON.stringify(output, null, 2) + "\n");
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
  if (e.expected !== "deny") {
    throw new Error(
      `prediction annotation on key "${key}" requires expected="deny", got "${e.expected}"`,
    );
  }
  if (e.by !== "prediction-block" && e.by !== "batch-sibling") {
    throw new Error(
      `prediction annotation on key "${key}" requires by ∈ {"prediction-block","batch-sibling"}, got ${JSON.stringify(e.by)}`,
    );
  }
  const validVerdicts = ["correct", "too_broad", "wrong", "INVESTIGATE"];
  if (!validVerdicts.includes(e.prediction.verdict)) {
    throw new Error(
      `prediction.verdict on key "${key}" must be one of ${validVerdicts.join(", ")}, got ${JSON.stringify(e.prediction.verdict)}`,
    );
  }
  if (e.prediction.verdict === "too_broad") {
    if (
      !Array.isArray(e.prediction.forbidden_blocks) ||
      e.prediction.forbidden_blocks.length === 0
    ) {
      throw new Error(
        `prediction.forbidden_blocks on key "${key}" must be a non-empty array when verdict="too_broad"`,
      );
    }
  }
  if (e.prediction.intent_must_contain !== undefined) {
    if (
      typeof e.prediction.intent_must_contain !== "string" ||
      e.prediction.intent_must_contain.length === 0
    ) {
      throw new Error(
        `prediction.intent_must_contain on key "${key}" must be a non-empty string when set`,
      );
    }
  }
  if (e.prediction.expected_mood !== undefined) {
    const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
    if (
      typeof e.prediction.expected_mood !== "string" ||
      !validMoods.includes(e.prediction.expected_mood as string)
    ) {
      throw new Error(
        `prediction.expected_mood on key "${key}" must be one of ${validMoods.join(", ")}, got ${JSON.stringify(e.prediction.expected_mood)}`,
      );
    }
  }
  if (e.prediction.expected_trust !== undefined) {
    const validTrusts = ["low", "normal", "high"];
    if (
      typeof e.prediction.expected_trust !== "string" ||
      !validTrusts.includes(e.prediction.expected_trust as string)
    ) {
      throw new Error(
        `prediction.expected_trust on key "${key}" must be one of ${validTrusts.join(", ")}, got ${JSON.stringify(e.prediction.expected_trust)}`,
      );
    }
  }
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
    const content = readTestRunFile(transcriptName, "mcp-state.json");
    return { ...defaults, ...JSON.parse(content) };
  } catch {
    return defaults;
  }
}

function writeMcpState(transcriptName: string, state: McpState): void {
  writeTestRunFile(transcriptName, "mcp-state.json", JSON.stringify(state, null, 2) + "\n");
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

  if (!fs.existsSync(TRANSCRIPT_PROJECT_DIR)) {
    return results;
  }

  const entries = fs.readdirSync(TRANSCRIPT_PROJECT_DIR);
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;

    const fullPath = path.join(TRANSCRIPT_PROJECT_DIR, entry);
    const name = entry.replace(".jsonl", "");

    // Skip if already labeled
    if (testRunFileExists(name, "labels.json")) continue;
    if (testRunFileExists(name, "labels.draft.json")) continue;

    // Skip sidechain transcripts
    try {
      const fd = fs.openSync(fullPath, "r");
      const buffer = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
      fs.closeSync(fd);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf-8").split("\n")[0];
      if (firstLine.includes("\"isSidechain\"")) continue;
    } catch {
      continue;
    }

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

  if (!fs.existsSync(TEST_RUNS_DIR)) {
    return results;
  }

  const entries = fs.readdirSync(TEST_RUNS_DIR);
  for (const entry of entries) {
    const dirPath = path.join(TEST_RUNS_DIR, entry);
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

const SCENARIOS_DIR = path.join(TEST_RUNS_DIR, "scenarios");
const FIXTURES_SCENARIOS_SUBPATH = path.join(
  "test-harness",
  "fixtures",
  "scenarios",
);

/** Absolute path to the scenarios root under TEST_RUNS_DIR. */
export function scenariosDir(): string {
  return SCENARIOS_DIR;
}

/**
 * Absolute path to the repo-tracked fixture scenarios directory:
 *   <root>/test-harness/fixtures/scenarios/
 * Honors AGENT_FRAMEWORK_ROOT (or a per-call working_dir override).
 */
export function fixturesScenariosDir(rootOverride?: string): string {
  const root = rootOverride ?? process.env.AGENT_FRAMEWORK_ROOT;
  if (!root) {
    throw new Error(
      "AGENT_FRAMEWORK_ROOT (or working_dir) required to locate test-harness/fixtures/scenarios/",
    );
  }
  return path.join(root, FIXTURES_SCENARIOS_SUBPATH);
}

/**
 * Resolve a scenario's on-disk directory. Validates the slug to keep
 * scenario names from escaping the scenarios root.
 */
export function scenarioDir(name: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid scenario name (must match [A-Za-z0-9._-]+): ${name}`);
  }
  const resolved = path.join(SCENARIOS_DIR, name);
  if (!resolved.startsWith(SCENARIOS_DIR)) {
    throw new Error(`scenario name escapes scenarios dir: ${name}`);
  }
  return resolved;
}

/**
 * Write a scenario object to disk at scenarios/<name>/scenario.json.
 * Caller is expected to have validated the object shape first.
 */
export function writeScenarioFile(name: string, scenario: unknown): string {
  const dir = scenarioDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "scenario.json");
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
  const file = path.join(scenarioDir(name), filename);
  if (!fs.existsSync(file)) {
    throw new Error(`${filename} not found for scenario "${name}" at ${file}`);
  }
  return fs.readFileSync(file, "utf-8");
}

/**
 * Describes one discoverable scenario across both trees. `inputPath` is
 * what the scenario runner reads (a home scenario.json or a repo fixture
 * .json); `outputDir` is where cache/ and report-scenario.json land —
 * always under ~/.agent-framework/test-runs/scenarios/<name>/ so the
 * repo-tracked fixture files never get polluted by per-run artifacts.
 * `error` is set when the fixture is malformed (filename stem does not
 * match scenario.name, or validateScenario rejects the JSON); such
 * entries must not be executed but are surfaced to the caller so the
 * user sees the broken fixture.
 */
export interface ScenarioSource {
  name: string;
  source: "home" | "fixture";
  inputPath: string;
  outputDir: string;
  hasReport: boolean;
  error?: string;
}

/**
 * Enumerate every scenario discoverable across home
 * (~/.agent-framework/test-runs/scenarios/) and the repo-tracked fixtures
 * (<root>/test-harness/fixtures/scenarios/). Entries are sorted
 * alphabetically by name.
 *
 * Per-fixture validation errors (filename stem != scenario.name, or
 * validateScenario rejection) are attached to the entry as `error`
 * without aborting discovery. Cross-tree slug collisions are infrastructure
 * bugs and throw — the caller (run_scenarios) wraps the discovery call in
 * a try/catch and surfaces that as a single <discovery> result entry.
 */
export function listAllScenarios(rootOverride?: string): ScenarioSource[] {
  const out = new Map<string, ScenarioSource>();

  if (fs.existsSync(SCENARIOS_DIR)) {
    for (const entry of fs.readdirSync(SCENARIOS_DIR)) {
      if (!/^[A-Za-z0-9._-]+$/.test(entry)) continue;
      const inputPath = path.join(SCENARIOS_DIR, entry, "scenario.json");
      if (!fs.existsSync(inputPath)) continue;
      const outputDir = path.join(SCENARIOS_DIR, entry);
      out.set(entry, {
        name: entry,
        source: "home",
        inputPath,
        outputDir,
        hasReport: fs.existsSync(path.join(outputDir, "report-scenario.json")),
      });
    }
  }

  let fixDir: string;
  try {
    fixDir = fixturesScenariosDir(rootOverride);
  } catch {
    return sortedScenarios(out);
  }
  if (!fs.existsSync(fixDir)) return sortedScenarios(out);

  for (const file of fs.readdirSync(fixDir)) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) continue;

    const inputPath = path.join(fixDir, file);
    const outputDir = path.join(SCENARIOS_DIR, name);
    const hasReport = fs.existsSync(path.join(outputDir, "report-scenario.json"));

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

    if (out.has(name)) {
      const homeInput = out.get(name)!.inputPath;
      throw new Error(
        `scenario slug "${name}" exists in BOTH trees:\n` +
          `  home:    ${homeInput}\n` +
          `  fixture: ${inputPath}\n` +
          `Slugs must be unique across sources. Delete one of the two files.`,
      );
    }

    out.set(name, {
      name,
      source: "fixture",
      inputPath,
      outputDir,
      hasReport,
      ...(fixtureError ? { error: fixtureError } : {}),
    });
  }
  return sortedScenarios(out);
}

function sortedScenarios(m: Map<string, ScenarioSource>): ScenarioSource[] {
  return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
}
