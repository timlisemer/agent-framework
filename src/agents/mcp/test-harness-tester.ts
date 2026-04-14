/**
 * Test Harness Tester — MCP tool handler for the tester subagent.
 *
 * Pure TypeScript + execFileSync. NO LLM calls. NO runAgent. NO Anthropic API.
 *
 * Actions:
 *   find_work       - Scan for testable transcripts (labeled but untested/failing)
 *   run_test        - Run replay.ts with --expect (costs $, max 5x)
 *   run_single_hook - Run replay.ts with --filter for one hook (max 20x)
 *   list            - Run replay.ts --list (free)
 *   expand          - Run replay.ts --list --expand (free)
 *   read_file       - Read report, labels, or notes
 *   append_notes    - Append to notes_and_questions.md
 *   git_hash        - Get current framework version
 *   help            - Full tester documentation
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
  getVersion,
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

function handleRunTest(
  transcriptName: string,
  rootOverride?: string,
  transcriptPathOverride?: string,
): string {
  checkAndIncrementRunLimit(transcriptName, "run_test");
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const labelsPath = path.join(transcriptRunDir(transcriptName), "labels.json");
  if (!fs.existsSync(labelsPath)) {
    throw new Error("labels.json not found. This transcript is not ready for testing.");
  }
  const output = runReplayCommand([
    "--transcript", transcriptPath,
    "--expect", labelsPath,
  ], 600000, rootOverride);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state) + "\n\nWORKFLOW: You must call run_single_hook (free, unlimited) before your next run_test.";
}

function handleRunSingleHook(
  transcriptName: string,
  hookKey: string,
  rootOverride?: string,
  truncateToLine?: number,
  transcriptPathOverride?: string,
): string {
  checkAndIncrementRunLimit(transcriptName, "run_single_hook");
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const labelsPath = path.join(transcriptRunDir(transcriptName), "labels.json");
  if (!fs.existsSync(labelsPath)) {
    throw new Error("labels.json not found. This transcript is not ready for testing.");
  }
  if (truncateToLine !== undefined) {
    if (!Number.isFinite(truncateToLine) || truncateToLine < 1) {
      throw new Error(
        `truncate_to_line must be a positive 1-based integer, got ${truncateToLine}`,
      );
    }
  }
  const args = [
    "--transcript", transcriptPath,
    "--expect", labelsPath,
    "--filter", hookKey,
  ];
  if (truncateToLine !== undefined) {
    args.push("--truncate-to-line", String(truncateToLine));
  }
  const output = runReplayCommand(args, 300000, rootOverride);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state) + "\n\nWORKFLOW: You must call run_single_hook (free, unlimited) before your next run_test.";
}

function handleList(
  transcriptName: string,
  rootOverride?: string,
  transcriptPathOverride?: string,
): string {
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const output = runReplayCommand(["--list", "--transcript", transcriptPath], 600000, rootOverride);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleExpand(
  transcriptName: string,
  target: string,
  depth: number,
  rootOverride?: string,
  transcriptPathOverride?: string,
): string {
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const args = ["--list", "--transcript", transcriptPath, "--expand", target];
  if (depth > 1) {
    args.push("--depth", String(depth));
  }
  const output = runReplayCommand(args, 600000, rootOverride);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleReadFile(transcriptName: string, filename: string): string {
  const allowedFiles = ["report.json", "report-single.json", "labels.json", "labels.draft.json", "notes_and_questions.md"];
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
  return getVersion();
}

function handleHelp(): string {
  return TESTER_HELP;
}

// ─── Transcript Path Resolution ────────────────────────────────────────────

function resolveTranscriptPath(transcriptName: string, override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`transcript_path override "${override}" does not exist`);
    }
    return override;
  }
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
  throw new Error(
    `Transcript not found for "${transcriptName}". Check the name and try find_work. ` +
    `If the transcript lives outside ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework, ` +
    `pass "transcript_path" to point at the file directly.`,
  );
}

// ─── Main Handler ──────────────────────────────────────────────────────────

export interface TesterInput {
  action: string;
  transcript_name?: string;
  target?: string;
  depth?: number;
  filename?: string;
  content?: string;
  working_dir?: string;
  hook_key?: string;
  /**
   * For run_single_hook: optional 1-based transcript line cap. When set,
   * replay.ts appends only transcript entries whose 1-based line index is
   * <= truncate_to_line before firing the target hook. Lets you score the
   * hook against a partial file state (e.g. pre-flush timing replay).
   */
  truncate_to_line?: number;
  /**
   * Absolute path to the transcript .jsonl file. Use when the transcript
   * lives outside the default ~/.claude/projects/-home-tim-Coding-public-
   * repos-agent-framework directory. After auto_label/scaffold has copied
   * the transcript into ~/.agent-framework/test-runs/<name>/, the override
   * is no longer needed; the resolver finds it there automatically.
   */
  transcript_path?: string;
}

export async function handleTestHarnessTester(input: TesterInput): Promise<string> {
  try {
    switch (input.action) {
      case "find_work":
        return handleFindWork();

      case "run_test":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleRunTest(input.transcript_name, input.working_dir, input.transcript_path);

      case "run_single_hook":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.hook_key) throw new Error("hook_key is required (tool_use_id or stop:N)");
        return handleRunSingleHook(
          input.transcript_name,
          input.hook_key,
          input.working_dir,
          input.truncate_to_line,
          input.transcript_path,
        );

      case "list":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleList(input.transcript_name, input.working_dir, input.transcript_path);

      case "expand":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.target) throw new Error("target is required (tool_use_id or stop:N)");
        return handleExpand(input.transcript_name, input.target, input.depth ?? 1, input.working_dir, input.transcript_path);

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
          "Valid actions: find_work, run_test, run_single_hook, list, expand, read_file, append_notes, git_hash, help"
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

### Step 1b: Run a single hook (iterative development)
Action: run_single_hook (transcript_name + hook_key required, working_dir required)
Runs ONLY the specified hook point. Skips all other pre-tool-use and stop LLM
calls. Does NOT count against the 5-run limit. Max 20 per transcript.
hook_key: tool_use_id prefix from report failures, or stop:N key.
Use this for iterative fix-test cycles.
Read report-single.json for results.

Optional parameter: truncate_to_line (1-based integer).
  When set, the harness appends only transcript lines whose 1-based index
  is <= truncate_to_line before firing the target hook. The hook still
  fires with its original tool_use_id because the input is built from the
  in-memory parsed lines, not from the on-disk temp transcript. Use this
  to reproduce timing-sensitive states (e.g. pre-flush replay where the
  text entry preceding a tool_use has not been written yet).

  report-single.json will include \`truncate_to_line\` at the top level and
  each scored event will carry an \`at\` field ("full" or the cap line).

### Labels: rich expectations

A labels.json entry may be either the legacy string form or a rich object:

  "toolu_014rEfFTifPuw3iud1KWZCQg": {
    "expected": "deny",
    "by": "respond-first",
    "at": "full"
  }

  "toolu_01R7fQpyC7s6E3BazAoBhM6y": [
    { "expected": "allow", "at": 105,
      "notes": "Pre-flush timing state: respond-first must skip, not fastDeny" },
    { "expected": "allow", "at": "full" }
  ]

- "expected" is the same four-value vocabulary as before (allow/deny/pass/block).
- "by" is an optional rule name. When set, the hook passes only if the
  decision matches AND the \`gate\` in tool-log matches \`by\`. A failure
  reason like \`decision matched (deny) but wrong rule: got "X", expected "Y"\`
  is written to the report when the decision is right but the rule is wrong.
- "at" is a 1-based transcript line index or "full". Each rich entry is
  scored only on a run whose truncate_to_line matches \`at\` (or "full" if
  \`at\` is absent/"full" and no truncation was requested).

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

### Step 6: Iterate with single-hook runs
Action: run_single_hook (transcript_name + hook_key)
For each failure: fix code, then run_single_hook to test just that hook.
If the same failure appears 3 times in a row, it is a CODE BUG, not LLM
non-determinism. Investigate the code path deeper.

### Step 7: Confirm with full run
Action: run_test (same transcript_name)
Only after all individual hooks pass via run_single_hook, run full test to
confirm no regressions. Skip if no code changes were made.

### Step 8: Repeat
Continue until:
- All failures resolved, OR
- Only failures matching notes_and_questions.md uncertainties remain

### Step 9: Record findings
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
  report.json               Test report from last full run
  report-single.json        Test report from last single-hook run
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
- Use this MCP tool ONLY for harness operations (run_test, run_single_hook, list, expand, read_file, append_notes)
- Use Read/Grep/Glob for investigating hook source code
- Use Write/Edit for fixing hook source code
- Use run_single_hook for iterative development (cheap, does not count against run limit)
- NEVER dismiss failures as "non-deterministic LLM behavior" without investigating code
- If run_single_hook returns the same result 3x in a row, it IS a code bug
`;
