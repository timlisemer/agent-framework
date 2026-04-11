/**
 * Test Harness Tester — MCP tool handler for the tester subagent.
 *
 * Pure TypeScript + execFileSync. NO LLM calls. NO runAgent. NO Anthropic API.
 *
 * Actions:
 *   find_work    - Scan for testable transcripts (labeled but untested/failing)
 *   run_test     - Run replay.ts with --expect (costs $, max 5x)
 *   list         - Run replay.ts --list (free)
 *   expand       - Run replay.ts --list --expand (free)
 *   read_file    - Read report, labels, or notes
 *   append_notes - Append to notes_and_questions.md
 *   git_hash     - Get current HEAD commit hash
 *   help         - Full tester documentation
 *
 * @module test-harness-tester
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findTestableTranscripts,
  transcriptRunDir,
  readTestRunFile,
  runReplayCommand,
  getGitHash,
  checkAndIncrementRunLimit,
  detectWorkflowState,
  formatStatusFooter,
  appendTestRunFile,
} from "./test-harness-shared.js";

// ─── Action Handlers ───────────────────────────────────────────────────────

function handleFindWork(): string {
  const transcripts = findTestableTranscripts();
  if (transcripts.length === 0) {
    return "No testable transcripts found. All labeled transcripts are passing or none have labels.json.";
  }
  const lines = ["TESTABLE TRANSCRIPTS:", ""];
  for (const t of transcripts) {
    lines.push(`  ${t.status}  ${t.name}`);
  }
  lines.push("");
  lines.push("Pick ONE transcript to test. UNTESTED transcripts have no report yet. FAILING transcripts have failures to investigate.");
  return lines.join("\n");
}

function handleRunTest(transcriptName: string): string {
  checkAndIncrementRunLimit(transcriptName, "run_test");
  const transcriptPath = resolveTranscriptPath(transcriptName);
  const labelsPath = path.join(transcriptRunDir(transcriptName), "labels.json");
  if (!fs.existsSync(labelsPath)) {
    throw new Error("labels.json not found. This transcript is not ready for testing.");
  }
  const output = runReplayCommand([
    "--transcript", transcriptPath,
    "--expect", labelsPath,
  ]);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleList(transcriptName: string): string {
  const transcriptPath = resolveTranscriptPath(transcriptName);
  const output = runReplayCommand(["--list", "--transcript", transcriptPath]);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleExpand(transcriptName: string, target: string, depth: number): string {
  const transcriptPath = resolveTranscriptPath(transcriptName);
  const args = ["--list", "--transcript", transcriptPath, "--expand", target];
  if (depth > 1) {
    args.push("--depth", String(depth));
  }
  const output = runReplayCommand(args);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleReadFile(transcriptName: string, filename: string): string {
  const allowedFiles = ["report.json", "labels.json", "labels.draft.json", "notes_and_questions.md"];
  if (!allowedFiles.includes(filename)) {
    throw new Error(`Cannot read "${filename}". Allowed files: ${allowedFiles.join(", ")}`);
  }
  return readTestRunFile(transcriptName, filename);
}

function handleAppendNotes(transcriptName: string, content: string): string {
  const filePath = appendTestRunFile(transcriptName, "notes_and_questions.md", content);
  const state = detectWorkflowState(transcriptName);
  return `Appended to ${filePath}` + formatStatusFooter(state);
}

function handleGitHash(): string {
  return getGitHash();
}

function handleHelp(): string {
  return TESTER_HELP;
}

// ─── Transcript Path Resolution ────────────────────────────────────────────

function resolveTranscriptPath(transcriptName: string): string {
  // Prefer test-runs copy
  const runPath = path.join(transcriptRunDir(transcriptName), "transcript.jsonl");
  if (fs.existsSync(runPath)) {
    return runPath;
  }
  // Fall back to project dir
  const projectPath = path.join(
    os.homedir(),
    ".claude", "projects", "-home-tim-Coding-public-repos-agent-framework",
    transcriptName + ".jsonl"
  );
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }
  throw new Error(`Transcript not found for "${transcriptName}". Check the name and try find_work.`);
}

// ─── Main Handler ──────────────────────────────────────────────────────────

export interface TesterInput {
  action: string;
  transcript_name?: string;
  target?: string;
  depth?: number;
  filename?: string;
  content?: string;
}

export async function handleTestHarnessTester(input: TesterInput): Promise<string> {
  try {
    switch (input.action) {
      case "find_work":
        return handleFindWork();

      case "run_test":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleRunTest(input.transcript_name);

      case "list":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleList(input.transcript_name);

      case "expand":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.target) throw new Error("target is required (tool_use_id or stop:N)");
        return handleExpand(input.transcript_name, input.target, input.depth ?? 1);

      case "read_file":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.filename) throw new Error("filename is required");
        return handleReadFile(input.transcript_name, input.filename);

      case "append_notes":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.content) throw new Error("content is required");
        return handleAppendNotes(input.transcript_name, input.content);

      case "git_hash":
        return handleGitHash();

      case "help":
        return handleHelp();

      default:
        throw new Error(
          `Unknown action: "${input.action}". ` +
          "Valid actions: find_work, run_test, list, expand, read_file, append_notes, git_hash, help"
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `ERROR: ${message}`;
  }
}

// ─── Help Documentation ────────────────────────────────────────────────────

const TESTER_HELP = `# Test Harness Tester -- Complete Reference

## Purpose

You run the test harness against finalized label files, analyze failures, fix
hook code, and re-run until tests pass.

## Workflow

### Step 0: Find work
Action: find_work
Returns transcripts with labels.json that need testing (UNTESTED or FAILING).
Pick ONE to process fully.

### Step 1: Run the test harness
Action: run_test (transcript_name required)
Runs all hooks against the transcript and compares decisions to labels.
COSTS REAL MONEY (LLM API calls). Maximum 5 runs per transcript.
The harness automatically builds the project first.

### Step 2: Read the report
Action: read_file (transcript_name, filename: "report.json")
Check failed count and failures array. For each failure:
- expected: what the label says should happen
- actual: what the hook actually decided
- gate and reason: which gate agent made the decision and why

### Step 3: Check labeler notes
Action: read_file (transcript_name, filename: "notes_and_questions.md")
If a failure corresponds to an uncertain label, it may be acceptable.
Add a note that the failure matches a known uncertainty.

### Step 4: Investigate hook code
Use Read, Grep, Glob tools (NOT this MCP tool) to examine hook source code.
Key source files:
- src/hooks/pre-tool-use.ts -- main safety gate (~400 lines)
- src/hooks/stop-response-check.ts -- stop hook
- src/agents/hooks/tool-approve.ts -- tool approval agent
- src/agents/hooks/tool-appeal.ts -- appeal agent
- src/agents/hooks/gate.ts -- gate agent
- src/utils/agent-configs.ts -- agent system prompts
- src/utils/micro-prediction.ts -- sync regex predictions
- src/utils/drift-detector.ts -- drift/anomaly detection heuristics

### Step 5: Fix hook code
Use Write, Edit tools (NOT this MCP tool) to fix hook source files.
Plan fixes carefully. Batch ALL fixes before re-running.

### Step 6: Re-run
Action: run_test (same transcript_name)
Compare results. If same failures persist or MORE failures (regression), stop and report.

### Step 7: Repeat
Continue until:
- All failures resolved, OR
- Only failures matching notes_and_questions.md uncertainties remain

Maximum 5 harness runs per transcript. Each run costs real money.

### Step 8: Record findings
Action: append_notes (transcript_name, content)
Prefix additions with [tester], include date and git hash.
Mark resolved items by appending resolution notes (never delete existing notes).

## Report Format

{
  "transcript": "/path/to/transcript.jsonl",
  "label_file": "~/.agent-framework/test-runs/<name>/labels.json",
  "commit": "abc1234...",
  "total_hooks_fired": 185,
  "scored": 73,
  "passed": 71,
  "failed": 2,
  "errors": 0,
  "elapsed_ms": 45200,
  "failures": [{ line, hook, tool, id, expected, actual, gate, reason }]
}

## Folder Structure

~/.agent-framework/test-runs/{transcript-name}/
  transcript.jsonl          Copy of original transcript
  labels.draft.json         Label file in progress (NOT ready for testing)
  labels.json               Finalized label file (ready for testing)
  report.json               Test report from last run
  notes_and_questions.md    Labeler/tester notes on uncertain decisions
  mcp-state.json            Run limit tracking
  cache/                    Ephemeral hook runtime files

## Using expand for investigation

Action: expand (transcript_name, target, depth)
Shows surrounding context for a specific hook point.
- target: tool_use_id or stop:N key from the report failures
- depth: 1 = +-3 messages, 2 = +-6, 3 = +-9

## Rules

- Process ONE transcript per invocation
- MINIMIZE test harness runs -- each costs real money (max 5)
- Do NOT modify labels.json -- only add notes
- Do NOT call build commands -- the harness builds automatically
- Do NOT label transcripts -- that is the labeler's job
- Do NOT use Bash -- use Read/Grep/Glob/Write/Edit for code investigation
- Use this MCP tool ONLY for harness operations (run_test, list, expand, read_file, append_notes)
- Use Read/Grep/Glob for investigating hook source code
- Use Write/Edit for fixing hook source code
`;
