/**
 * Test Harness Labeler — MCP tool handler for the labeler subagent.
 *
 * Pure TypeScript + execFileSync. NO LLM calls. NO runAgent. NO Anthropic API.
 *
 * Actions:
 *   find_work       - Scan for unlabeled transcripts
 *   generate_labels - Run replay.ts --generate-labels (costs $, max 1x)
 *   scaffold        - Run replay.ts --scaffold (free)
 *   list            - Run replay.ts --list (free)
 *   expand          - Run replay.ts --list --expand (free)
 *   validate        - Run replay.ts --validate (free)
 *   update_label    - Update one label + reasoning in draft
 *   update_labels   - Batch update multiple labels + reasoning
 *   finalize        - Validate, check reasoning, rename draft to final
 *   read_file       - Read labels_draft, labels, or notes
 *   append_notes    - Append to notes_and_questions.md
 *   git_hash        - Get current framework version
 *   help            - Full labeler documentation
 *
 * @module test-harness-labeler
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  findUnlabeledTranscripts,
  transcriptRunDir,
  testRunFileExists,
  readTestRunFile,
  readLabelFile,
  updateSingleLabel,
  updateMultipleLabels,
  runReplayCommand,
  getVersion,
  checkAndIncrementRunLimit,
  detectWorkflowState,
  formatStatusFooter,
  appendTestRunFile,
} from "./test-harness-shared.js";

// ─── Action Handlers ───────────────────────────────────────────────────────

function handleFindWork(dateFrom?: string, dateTo?: string): string {
  const transcripts = findUnlabeledTranscripts(10, dateFrom, dateTo);
  if (transcripts.length === 0) {
    const dateHint = dateFrom || dateTo
      ? ` in date range ${dateFrom || "any"}..${dateTo || "any"}`
      : "";
    return `No unlabeled transcripts found${dateHint}. All transcripts have labels.draft.json or labels.json.`;
  }
  const lines = ["UNLABELED TRANSCRIPTS (sorted by size, largest first):", ""];
  for (const t of transcripts) {
    lines.push(`  ${t.lines} lines  ${t.name}`);
  }
  lines.push("");
  lines.push("Pick ONE transcript to label. Use generate_labels (costs $) or scaffold (free) to start.");
  return lines.join("\n");
}

function handleGenerateLabels(transcriptName: string): string {
  checkAndIncrementRunLimit(transcriptName, "generate_labels");
  const transcriptPath = resolveTranscriptPath(transcriptName);
  const output = runReplayCommand(["--generate-labels", "--transcript", transcriptPath]);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleScaffold(transcriptName: string): string {
  const transcriptPath = resolveTranscriptPath(transcriptName);
  const output = runReplayCommand(["--scaffold", "--transcript", transcriptPath]);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleList(transcriptName: string): string {
  const transcriptPath = resolveTranscriptForList(transcriptName);
  const output = runReplayCommand(["--list", "--transcript", transcriptPath]);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleExpand(transcriptName: string, target: string, depth: number): string {
  const transcriptPath = resolveTranscriptForList(transcriptName);
  const args = ["--list", "--transcript", transcriptPath, "--expand", target];
  if (depth > 1) {
    args.push("--depth", String(depth));
  }
  const output = runReplayCommand(args);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleValidate(transcriptName: string): string {
  const transcriptPath = resolveTranscriptForList(transcriptName);
  const draftPath = path.join(transcriptRunDir(transcriptName), "labels.draft.json");
  if (!fs.existsSync(draftPath)) {
    throw new Error("labels.draft.json not found. Generate labels first.");
  }
  try {
    const output = runReplayCommand(["--validate", "--transcript", transcriptPath, "--expect", draftPath]);
    const state = detectWorkflowState(transcriptName);
    return output + formatStatusFooter(state);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return "VALIDATION FAILED:\n" + message;
  }
}

function handleUpdateLabel(transcriptName: string, key: string, value: string, reasoning: string): string {
  const labelFile = updateSingleLabel(transcriptName, key, value, reasoning);
  const remaining = Object.values(labelFile.labels).filter((v) => v === "INVESTIGATE").length;
  const state = detectWorkflowState(transcriptName);
  return `Updated: "${key}" = "${value}"\nReasoning recorded.\nRemaining INVESTIGATE: ${remaining}` + formatStatusFooter(state);
}

function handleUpdateLabels(
  transcriptName: string,
  updates: Array<{ key: string; value: string; reasoning: string }>,
): string {
  const labelFile = updateMultipleLabels(transcriptName, updates);
  const remaining = Object.values(labelFile.labels).filter((v) => v === "INVESTIGATE").length;
  const state = detectWorkflowState(transcriptName);
  return `Updated ${updates.length} labels.\nRemaining INVESTIGATE: ${remaining}` + formatStatusFooter(state);
}

function handleFinalize(transcriptName: string): string {
  // Step 1: Check draft exists
  if (!testRunFileExists(transcriptName, "labels.draft.json")) {
    throw new Error("labels.draft.json not found. Nothing to finalize.");
  }

  // Step 2: Read and validate
  const labelFile = readLabelFile(transcriptName, true);
  const investigateRemaining = Object.entries(labelFile.labels).filter(
    ([, v]) => v === "INVESTIGATE"
  );
  if (investigateRemaining.length > 0) {
    const keys = investigateRemaining.map(([k]) => k).join(", ");
    throw new Error(
      `Cannot finalize: ${investigateRemaining.length} labels still marked INVESTIGATE: ${keys}`
    );
  }

  // Step 3: Check reasoning coverage
  const labelKeys = Object.keys(labelFile.labels);
  const missingReasoning = labelKeys.filter(
    (k) => !labelFile.reasoning || !labelFile.reasoning[k]
  );
  if (missingReasoning.length > 0) {
    throw new Error(
      `Cannot finalize: ${missingReasoning.length} labels missing reasoning. ` +
      `Use update_label to add reasoning for: ${missingReasoning.slice(0, 5).join(", ")}${missingReasoning.length > 5 ? "..." : ""}`
    );
  }

  // Step 4: Run validate via replay.ts
  const transcriptPath = resolveTranscriptForList(transcriptName);
  const draftPath = path.join(transcriptRunDir(transcriptName), "labels.draft.json");
  try {
    runReplayCommand(["--validate", "--transcript", transcriptPath, "--expect", draftPath]);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error("Validation failed, cannot finalize:\n" + message);
  }

  // Step 5: Rename draft to final
  const finalPath = path.join(transcriptRunDir(transcriptName), "labels.json");
  fs.renameSync(draftPath, finalPath);

  const state = detectWorkflowState(transcriptName);
  return `Finalized: labels.draft.json renamed to labels.json\nTotal labels: ${labelKeys.length}` + formatStatusFooter(state);
}

function handleReadFile(transcriptName: string, filename: string): string {
  const allowedFiles = ["labels.draft.json", "labels.json", "notes_and_questions.md"];
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
  return LABELER_HELP;
}

// ─── Transcript Path Resolution ────────────────────────────────────────────

function resolveTranscriptPath(transcriptName: string): string {
  // For generate_labels/scaffold, use original transcript from project dir
  const projectPath = path.join(
    path.join(os.homedir(), ".claude", "projects", "-home-tim-Coding-public-repos-agent-framework"),
    transcriptName + ".jsonl"
  );
  if (fs.existsSync(projectPath)) {
    return projectPath;
  }
  // Fall back to test-runs copy
  const runPath = path.join(transcriptRunDir(transcriptName), "transcript.jsonl");
  if (fs.existsSync(runPath)) {
    return runPath;
  }
  throw new Error(`Transcript not found for "${transcriptName}". Check the name and try find_work.`);
}

function resolveTranscriptForList(transcriptName: string): string {
  // Prefer test-runs copy (always there after generate/scaffold)
  const runPath = path.join(transcriptRunDir(transcriptName), "transcript.jsonl");
  if (fs.existsSync(runPath)) {
    return runPath;
  }
  return resolveTranscriptPath(transcriptName);
}

// ─── Main Handler ──────────────────────────────────────────────────────────

export interface LabelerInput {
  action: string;
  transcript_name?: string;
  target?: string;
  depth?: number;
  key?: string;
  value?: string;
  reasoning?: string;
  updates?: Array<{ key: string; value: string; reasoning: string }>;
  filename?: string;
  content?: string;
  date_from?: string;
  date_to?: string;
}

export async function handleTestHarnessLabeler(input: LabelerInput): Promise<string> {
  try {
    switch (input.action) {
      case "find_work":
        return handleFindWork(input.date_from, input.date_to);

      case "generate_labels":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleGenerateLabels(input.transcript_name);

      case "scaffold":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleScaffold(input.transcript_name);

      case "list":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleList(input.transcript_name);

      case "expand":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.target) throw new Error("target is required (tool_use_id or stop:N)");
        return handleExpand(input.transcript_name, input.target, input.depth ?? 1);

      case "validate":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleValidate(input.transcript_name);

      case "update_label":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.key) throw new Error("key is required");
        if (!input.value) throw new Error("value is required");
        if (!input.reasoning) throw new Error("reasoning is required");
        return handleUpdateLabel(input.transcript_name, input.key, input.value, input.reasoning);

      case "update_labels":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.updates || !Array.isArray(input.updates) || input.updates.length === 0) {
          throw new Error("updates array is required and must be non-empty");
        }
        return handleUpdateLabels(input.transcript_name, input.updates);

      case "finalize":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleFinalize(input.transcript_name);

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
          "Valid actions: find_work, generate_labels, scaffold, list, expand, validate, " +
          "update_label, update_labels, finalize, read_file, append_notes, git_hash, help"
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `ERROR: ${message}`;
  }
}

// ─── Help Documentation ────────────────────────────────────────────────────

const LABELER_HELP = `# Test Harness Labeler -- Complete Reference

## Purpose

You label test harness transcripts for the agent-framework project. You find
unlabeled transcripts, generate initial labels from actual hook decisions, then
review and correct those labels using hindsight from the transcript.

## Workflow

Follow this workflow exactly. Do not deviate.

### Step 0: Find work
Action: find_work (optional: date_from, date_to in YYYY-MM-DD format)
Returns the 10 largest unlabeled transcripts. Pick ONE to process fully.
Use date_from/date_to to filter by file modification date.

### Step 1: Generate initial labels
Action: generate_labels (transcript_name required)
Runs all hooks against the transcript and records their actual decisions.
Creates labels.draft.json in ~/.agent-framework/test-runs/{name}/.
COSTS REAL MONEY (LLM API calls). Run ONCE per transcript. NEVER re-run.

Alternative: scaffold (transcript_name required)
Free heuristic-based labels from user reactions. Less accurate but no cost.

### Step 2: Read the draft labels
Action: read_file (transcript_name, filename: "labels.draft.json")
Review all labels. Focus on denials and blocks first.

### Step 3: Review denials
For every "deny" or "block" label, investigate with expand:
Action: expand (transcript_name, target: tool_use_id or stop:N, depth: 1-3)

Key questions:
- Did the user continue normally after this? -> Change to "allow"/"pass"
- Did the user express frustration or correct the AI? -> Keep "deny"/"block"
- Was the tool call genuinely dangerous/wrong? -> Keep "deny"/"block"

### Step 4: Review approvals
For every "allow" or "pass" label, verify:
- Did the user react negatively? -> Change to "deny"/"block"
- Did the tool do something not asked for? -> Change to "deny"
- User continued normally? -> Keep "allow"/"pass"

### Step 5: Update labels
Action: update_label (transcript_name, key, value, reasoning)
Action: update_labels (transcript_name, updates: [{key, value, reasoning}, ...])

Every label MUST have reasoning explaining your decision.

### Step 6: Record uncertainty
For any label where confidence < 80%:
Action: append_notes (transcript_name, content)
Include version (from git_hash action), date, tool_use_id, context, uncertainty.

### Step 7: Validate
Action: validate (transcript_name)
Checks all labels are present and valid. Fix any issues.

### Step 8: Finalize
Action: finalize (transcript_name)
Validates, checks reasoning coverage, renames draft to labels.json.

## Decision Guidelines

- Tool call the user accepted and continued from = "allow"
- Tool call that led to frustration, correction, or undo = "deny"
- Stop point after which user continued with new task or expressed satisfaction = "pass"
- Stop point after which user said AI stopped too early or missed something = "block"

## Label Values

| Hook type | Valid values |
|-----------|-------------|
| Tool calls (pre-tool-use) | "allow", "deny" |
| Stop points (stop-response-check) | "pass", "block" |

"INVESTIGATE" is a placeholder that must be resolved before finalize.

## Transcript Format

Each .jsonl file has one JSON object per line. The type field determines the line type:
- permission-mode: session permission config
- file-history-snapshot: file state at session start
- attachment: attached files/images
- system: system messages
- user: user messages (real prompts or tool results)
- assistant: assistant responses (may contain tool_use blocks)

Key fields:
- isMeta: If true on a user message, it is system-injected, not real user input.
- isSidechain: If true, the transcript belongs to a subagent. Do not use.
- message.stop_reason: "end_turn", "tool_use", or null (streaming chunk).
- tool_use blocks: {type:"tool_use", id:"toolu_...", name:"...", input:{...}}
- tool_result blocks: Found in user messages as array content. Tool returns, not real prompts.

Only use main session transcripts, not sidechain/subagent transcripts.

## Label File Format

{
  "_meta": { transcript, created, commit, total_hooks, needs_review },
  "labels": { "toolu_01...": "allow", "stop:20": "block" },
  "reasoning": { "toolu_01...": "User continued normally", "stop:20": "User said AI stopped too early" }
}

## Notes Format

# Notes and Questions
Version: {version from git_hash action}
Date: {ISO date}

## {tool_use_id or stop:N} - Label: {value}
**Context**: What the tool call did
**User reaction**: What the user said/did after
**Uncertainty**: Why you are unsure
**Leaning**: Which label you chose and why

## Folder Structure

~/.agent-framework/test-runs/{transcript-name}/
  transcript.jsonl          Copy of original transcript
  labels.draft.json         Label file in progress
  labels.json               Finalized label file
  report.json               Test report from last run
  notes_and_questions.md    Uncertainty notes
  mcp-state.json            Run limit tracking
  cache/                    Ephemeral hook runtime files

## Rules

- Process ONE transcript per invocation
- NEVER re-run generate_labels after Step 1
- list, expand, validate are FREE (no LLM calls, no cost)
- Only generate_labels costs money (Step 1)
- Be conservative -- when in doubt, keep the hook's original decision and note uncertainty
- Do NOT read transcript .jsonl files directly -- use list and expand
- Do NOT read source code or attempt to fix hooks
- Do NOT attempt to run tests
- ONLY use this MCP tool. Do NOT use any other tool (Read, Write, Edit, Bash, Grep, Glob)
`;
