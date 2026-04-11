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

export function runReplayCommand(args: string[], timeoutMs: number = 600000, rootOverride?: string): string {
  const root = rootOverride || getAgentFrameworkRoot();
  const npxPath = getNpxPath();
  const replayPath = path.join(root, "test-harness", "replay.ts");
  const fullArgs = ["tsx", replayPath, ...args];

  // Use spawnSync to capture both stdout and stderr.
  // replay.ts prints user-facing output to stderr and only file paths to stdout.
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
        `replay.ts timed out after ${Math.round(timeoutMs / 1000)}s. ` +
        `The transcript may be too large for the current timeout. ` +
        `Partial output:\n${(stderr || stdout || "(none)").slice(0, 500)}`
      );
    }
    throw new Error(`replay.ts spawn failed: ${result.error.message}`);
  }

  // Process killed by signal without error (e.g. external SIGTERM/SIGKILL)
  if (result.signal) {
    throw new Error(
      `replay.ts was killed by signal ${result.signal}. ` +
      `Partial output:\n${(stderr || stdout || "(none)").slice(0, 500)}`
    );
  }

  // Exit code 1 = test failures (valid output with failure details)
  // Exit code 2 = harness error (incomplete labels, build failure, parse error)
  // Any other non-zero = unexpected crash
  if (result.status !== null && result.status !== 0 && result.status !== 1) {
    throw new Error(
      `replay.ts exited with code ${result.status}: ` +
      `${(stderr || stdout || "(no output)").slice(0, 1000)}`
    );
  }

  const output = (stdout + (stderr ? "\n" + stderr : "")).trim();
  if (!output) {
    throw new Error("replay.ts produced no output — command may have failed silently");
  }

  return output;
}

// ─── Version ──────────────────────────────────────────────────────────────

import { VERSION } from "../../version.js";

export function getVersion(): string {
  return VERSION;
}

// ─── Label File Operations ─────────────────────────────────────────────────

interface LabelFile {
  _meta?: Record<string, unknown>;
  labels: Record<string, string>;
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
}

function readMcpState(transcriptName: string): McpState {
  const defaults: McpState = { generate_labels_count: 0, scaffold_count: 0, run_test_count: 0 };
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

export function checkAndIncrementRunLimit(transcriptName: string, action: "generate_labels" | "scaffold" | "run_test"): void {
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
  } else {
    if (state.run_test_count >= 5) {
      throw new Error(
        "Maximum 5 test runs reached for this transcript. " +
        "Each run costs real money. Report current status and stop."
      );
    }
    state.run_test_count++;
  }
  writeMcpState(transcriptName, state);
}

export function rollbackRunLimit(transcriptName: string, action: "generate_labels" | "scaffold" | "run_test"): void {
  const state = readMcpState(transcriptName);
  if (action === "generate_labels" && state.generate_labels_count > 0) {
    state.generate_labels_count--;
  } else if (action === "scaffold" && state.scaffold_count > 0) {
    state.scaffold_count--;
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
