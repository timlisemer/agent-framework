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
  writeLabelFile,
  updateSingleLabel,
  updateMultipleLabels,
  setRichLabel,
  type RichExpectation,
  runReplayCommand,
  getVersion,
  checkAndIncrementRunLimit,
  rollbackRunLimit,
  detectWorkflowState,
  formatStatusFooter,
  appendTestRunFile,
} from "./test-harness-shared.js";

// ─── Action Handlers ───────────────────────────────────────────────────────

function handleFindWork(dateFrom?: string, dateTo?: string, limit?: number): string {
  const transcripts = findUnlabeledTranscripts(10, dateFrom, dateTo);
  if (transcripts.length === 0) {
    const dateHint = dateFrom || dateTo
      ? ` in date range ${dateFrom || "any"}..${dateTo || "any"}`
      : "";
    return `No unlabeled transcripts found${dateHint}.`;
  }
  const lines = ["UNLABELED TRANSCRIPTS (sorted by size, largest first):", ""];
  for (const t of transcripts) {
    lines.push(`  ${t.lines} lines  ${t.name}`);
  }
  lines.push("");
  const effectiveLimit = limit === undefined || limit === null ? 1 : limit === 0 ? transcripts.length : Math.min(limit, transcripts.length);
  const limitDesc = limit === 0
    ? "Process ALL unlabeled transcripts."
    : `Process ${effectiveLimit} transcript(s).`;
  lines.push(limitDesc + " Use auto_label (recommended) to start each one.");
  return lines.join("\n");
}

function handleGenerateLabels(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  checkAndIncrementRunLimit(transcriptName, "generate_labels");
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const output = runReplayCommand(
    ["--generate-labels", "--transcript", transcriptPath],
    1800000,
    rootOverride,
  );
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleScaffold(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);
  const output = runReplayCommand(
    ["--scaffold", "--transcript", transcriptPath],
    600000,
    rootOverride,
  );
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleAutoLabel(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  const transcriptPath = resolveTranscriptPath(transcriptName, transcriptPathOverride);

  // Step 1: Run scaffold (free heuristic) — enforces 1x limit inside auto_label only
  checkAndIncrementRunLimit(transcriptName, "scaffold");
  runReplayCommand(
    ["--scaffold", "--transcript", transcriptPath],
    600000,
    rootOverride,
  );

  // Save scaffold results before generate_labels overwrites labels.draft.json
  const scaffoldData = readLabelFile(transcriptName, true);
  // auto_label only merges string-form labels. scaffold and generate_labels
  // both write plain strings, so it's safe to narrow here.
  const scaffoldLabels: Record<string, string> = { ...scaffoldData.labels } as Record<string, string>;
  const scaffoldReasoning = { ...(scaffoldData.reasoning ?? {}) };

  // Step 2: Run generate_labels (costs $, enforces 1x limit)
  checkAndIncrementRunLimit(transcriptName, "generate_labels");
  let genError: string | null = null;
  try {
    runReplayCommand(
      ["--generate-labels", "--transcript", transcriptPath],
      1800000,
      rootOverride,
    );
  } catch (err) {
    genError = err instanceof Error ? err.message : String(err);
    // Rollback both counters so auto_label can be fully retried
    rollbackRunLimit(transcriptName, "generate_labels");
    rollbackRunLimit(transcriptName, "scaffold");
  }

  if (genError) {
    // Restore scaffold draft (generate_labels may have partially overwritten it)
    writeLabelFile(transcriptName, true, {
      _meta: {
        ...(scaffoldData._meta ?? {}),
        method: "auto_label_scaffold_only",
        generate_labels_error: genError,
      },
      labels: scaffoldLabels,
      reasoning: Object.fromEntries(
        Object.entries(scaffoldReasoning).map(([k, v]) => [k, `[scaffold-only] ${v}`])
      ),
    });
    const state = detectWorkflowState(transcriptName);
    return [
      `Auto-label partial for "${transcriptName}" (generate_labels failed):`,
      `  Error: ${genError}`,
      `  Scaffold labels preserved: ${Object.keys(scaffoldLabels).length}`,
      "",
      "Scaffold (user reactions) used as sole signal.",
      "Review with expand, update any that need correction, then finalize.",
      "auto_label can be retried (counters were rolled back).",
      formatStatusFooter(state),
    ].join("\n");
  }

  // Read generate_labels results (it overwrote labels.draft.json)
  const genData = readLabelFile(transcriptName, true);
  const genLabels: Record<string, string> = genData.labels as Record<string, string>;
  const genReasoning = genData.reasoning ?? {};

  // Step 3: Merge — scaffold is baseline, hooks are advisory
  const mergedLabels: Record<string, string> = {};
  const mergedReasoning: Record<string, string> = {};
  let agreeCount = 0;
  let conflictCount = 0;

  const allKeys = new Set([...Object.keys(scaffoldLabels), ...Object.keys(genLabels)]);

  for (const key of allKeys) {
    const sVal = scaffoldLabels[key];
    const gVal = genLabels[key];
    const sReason = scaffoldReasoning[key] ?? "";
    const gReason = genReasoning[key] ?? "";

    if (!sVal && gVal) {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[hooks-only] hook=${gVal} (${gReason}). Not in scaffold.`;
      conflictCount++;
    } else if (sVal && !gVal) {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[scaffold-only] scaffold=${sVal} (${sReason}). Not in hooks.`;
      conflictCount++;
    } else if (sVal === "INVESTIGATE" || gVal === "INVESTIGATE") {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[flagged] scaffold=${sVal} (${sReason}) | hook=${gVal} (${gReason})`;
      conflictCount++;
    } else if (sVal === gVal) {
      mergedLabels[key] = sVal;
      mergedReasoning[key] = `[agree] both=${sVal}. scaffold: ${sReason} | hook: ${gReason}`;
      agreeCount++;
    } else {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[CONFLICT] scaffold=${sVal} (${sReason}) | hook=${gVal} (${gReason}). Hooks are NOT authoritative.`;
      conflictCount++;
    }
  }

  // Write merged draft
  writeLabelFile(transcriptName, true, {
    _meta: {
      ...(genData._meta ?? {}),
      method: "auto_label",
      agreed: agreeCount,
      conflicts: conflictCount,
      needs_review: conflictCount,
    },
    labels: mergedLabels,
    reasoning: mergedReasoning,
  });

  const state = detectWorkflowState(transcriptName);
  return [
    `Auto-label complete for "${transcriptName}":`,
    `  Total: ${allKeys.size}`,
    `  Agreed (high confidence): ${agreeCount}`,
    `  Conflicts (INVESTIGATE): ${conflictCount}`,
    "",
    "Scaffold (user reactions) is the baseline. Hook decisions are advisory.",
    "Review all INVESTIGATE labels with expand, lean toward user reactions when in doubt.",
    formatStatusFooter(state),
  ].join("\n");
}

function handleList(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  const transcriptPath = resolveTranscriptForList(transcriptName, transcriptPathOverride);
  const output = runReplayCommand(
    ["--list", "--transcript", transcriptPath],
    600000,
    rootOverride,
  );
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleExpand(
  transcriptName: string,
  target: string,
  depth: number,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  const transcriptPath = resolveTranscriptForList(transcriptName, transcriptPathOverride);
  const args = ["--list", "--transcript", transcriptPath, "--expand", target];
  if (depth > 1) {
    args.push("--depth", String(depth));
  }
  const output = runReplayCommand(args, 600000, rootOverride);
  const state = detectWorkflowState(transcriptName);
  return output + formatStatusFooter(state);
}

function handleValidate(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  const transcriptPath = resolveTranscriptForList(transcriptName, transcriptPathOverride);
  const draftPath = path.join(transcriptRunDir(transcriptName), "labels.draft.json");
  if (!fs.existsSync(draftPath)) {
    throw new Error("labels.draft.json not found. Generate labels first.");
  }
  try {
    const output = runReplayCommand(
      ["--validate", "--transcript", transcriptPath, "--expect", draftPath],
      600000,
      rootOverride,
    );
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

function handleSetLabel(
  transcriptName: string,
  key: string,
  expectation: RichExpectation | RichExpectation[],
  reasoning: string,
): string {
  setRichLabel(transcriptName, key, expectation, reasoning);
  const state = detectWorkflowState(transcriptName);
  const desc = Array.isArray(expectation)
    ? `${expectation.length} rich entries`
    : `expected=${expectation.expected}${expectation.by ? `, by=${expectation.by}` : ""}${expectation.at !== undefined ? `, at=${expectation.at}` : ""}`;
  return `Set rich label for "${key}" (${desc})` + formatStatusFooter(state);
}

function handleFinalize(
  transcriptName: string,
  transcriptPathOverride?: string,
  rootOverride?: string,
): string {
  // Step 1: Check draft exists
  if (!testRunFileExists(transcriptName, "labels.draft.json")) {
    throw new Error("labels.draft.json not found. Nothing to finalize.");
  }

  // Step 2: Read and validate
  const labelFile = readLabelFile(transcriptName, true);
  const unwrapExpected = (v: unknown): string[] => {
    if (typeof v === "string") return [v];
    if (Array.isArray(v)) {
      const out: string[] = [];
      for (const e of v) {
        if (e && typeof e === "object" && typeof (e as { expected?: unknown }).expected === "string") {
          out.push((e as { expected: string }).expected);
        }
      }
      return out;
    }
    if (v && typeof v === "object" && typeof (v as { expected?: unknown }).expected === "string") {
      return [(v as { expected: string }).expected];
    }
    return [];
  };
  const investigateRemaining = Object.entries(labelFile.labels).filter(
    ([, v]) => unwrapExpected(v).some((x) => x === "INVESTIGATE"),
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
  const transcriptPath = resolveTranscriptForList(transcriptName, transcriptPathOverride);
  const draftPath = path.join(transcriptRunDir(transcriptName), "labels.draft.json");
  try {
    runReplayCommand(
      ["--validate", "--transcript", transcriptPath, "--expect", draftPath],
      600000,
      rootOverride,
    );
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

function resolveTranscriptPath(transcriptName: string, override?: string): string {
  // Explicit override wins (e.g. sessions from a different project dir
  // that the default resolver doesn't know about, like iocto transcripts).
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`transcript_path override "${override}" does not exist`);
    }
    return override;
  }
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
  throw new Error(
    `Transcript not found for "${transcriptName}". Check the name and try find_work. ` +
    `If the transcript lives outside ~/.claude/projects/-home-tim-Coding-public-repos-agent-framework, ` +
    `pass "transcript_path" to point at the file directly.`,
  );
}

function resolveTranscriptForList(transcriptName: string, override?: string): string {
  if (override) {
    if (!fs.existsSync(override)) {
      throw new Error(`transcript_path override "${override}" does not exist`);
    }
    return override;
  }
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
  limit?: number;
  /**
   * For set_label: a rich expectation (or array of rich expectations).
   * Shape: { expected, by?, at?, notes? }. See test-harness-shared.ts
   * :RichExpectation for the full contract.
   */
  expectation?: RichExpectation | RichExpectation[];
  /**
   * Absolute path to the transcript .jsonl file. Use when the transcript
   * lives outside the default ~/.claude/projects/-home-tim-Coding-public-
   * repos-agent-framework directory (e.g. a session from another project
   * like iocto). Applies to auto_label / generate_labels / scaffold /
   * list / expand / validate. After auto_label or scaffold runs, the
   * transcript is copied into ~/.agent-framework/test-runs/<name>/ and
   * subsequent actions find it there automatically, so the override is
   * only needed once per transcript.
   */
  transcript_path?: string;
  /**
   * Local repo path. When set, the labeler invokes replay.ts from this
   * directory instead of the deployed AGENT_FRAMEWORK_ROOT, so locally
   * edited test-harness/ source is used. Mirrors the tester's existing
   * `working_dir` option. Without this, the labeler runs the previously
   * deployed test-harness code from /mnt/docker-data/... which won't
   * include local edits.
   */
  working_dir?: string;
}

export async function handleTestHarnessLabeler(input: LabelerInput): Promise<string> {
  try {
    switch (input.action) {
      case "find_work":
        return handleFindWork(input.date_from, input.date_to, input.limit);

      case "auto_label":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleAutoLabel(input.transcript_name, input.transcript_path, input.working_dir);

      case "generate_labels":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleGenerateLabels(input.transcript_name, input.transcript_path, input.working_dir);

      case "scaffold":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleScaffold(input.transcript_name, input.transcript_path, input.working_dir);

      case "list":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleList(input.transcript_name, input.transcript_path, input.working_dir);

      case "expand":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.target) throw new Error("target is required (tool_use_id or stop:N)");
        return handleExpand(input.transcript_name, input.target, input.depth ?? 1, input.transcript_path, input.working_dir);

      case "validate":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleValidate(input.transcript_name, input.transcript_path, input.working_dir);

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

      case "set_label":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.key) throw new Error("key is required");
        if (input.expectation === undefined) throw new Error("expectation is required (RichExpectation or RichExpectation[])");
        if (!input.reasoning) throw new Error("reasoning is required");
        return handleSetLabel(input.transcript_name, input.key, input.expectation, input.reasoning);

      case "finalize":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleFinalize(input.transcript_name, input.transcript_path, input.working_dir);

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
          "Valid actions: find_work, auto_label, generate_labels, scaffold, list, expand, validate, " +
          "update_label, update_labels, set_label, finalize, read_file, append_notes, git_hash, help"
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
unlabeled transcripts, create initial labels using auto_label (merges free
heuristic scaffold with hook replay), then review and resolve conflicts.

## Workflow

Follow this workflow exactly. Do not deviate.

### Step 0: Find work
Action: find_work (optional: date_from, date_to, limit)
Returns the 10 largest unlabeled transcripts. limit controls how many to process
(omit=1, 0=unlimited, N=N). Use date_from/date_to to filter by file modification date.

### Step 1: Create initial labels
Action: auto_label (transcript_name required) -- RECOMMENDED
Runs scaffold (free heuristic from user reactions) then generate_labels (hook
replay, costs $), and merges both signals. Where they agree the label is high
confidence. Where they disagree the label is set to INVESTIGATE with both
perspectives recorded. Scaffold is the closer-to-truth baseline; hooks are
advisory because they are imperfect (that is why we are labeling).

Alternative standalone actions (auto_label is preferred):
- generate_labels (costs $, max 1x) -- hook replay only
- scaffold (free, unlimited standalone) -- heuristic only

### Step 2: Read the draft labels
Action: read_file (transcript_name, filename: "labels.draft.json")
Review all labels. Focus on INVESTIGATE labels first (these are conflicts).

### Step 3: Expand and resolve INVESTIGATE labels
For every INVESTIGATE label, investigate with expand:
Action: expand (transcript_name, target: tool_use_id or stop:N, depth: 1-3)
Read the reasoning prefix ([agree], [CONFLICT], [flagged], [hooks-only], [scaffold-only])
to understand what happened. Lean toward the scaffold (user reaction) when in doubt.

### Step 4: Review agreed labels
For every agreed label, spot-check a sample:
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

### Step 9: Loop
If limit allows more transcripts, go back to Step 1 with the next transcript.

## Trust Hierarchy

1. User reactions (scaffold) -- closest to ground truth
2. Hook decisions (generate_labels) -- advisory, hooks are imperfect
3. When they disagree -- INVESTIGATE, lean toward user reactions

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
  "_meta": { transcript, created, commit, total_hooks, needs_review, method, agreed, conflicts },
  "labels": { "toolu_01...": "allow", "stop:20": "block" },
  "reasoning": { "toolu_01...": "[agree] both=allow. scaffold: ... | hook: ...", "stop:20": "[CONFLICT] scaffold=pass (...) | hook=block (...)" }
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

- NEVER re-run auto_label or generate_labels after Step 1
- list, expand, validate are FREE (no LLM calls, no cost)
- Only auto_label and generate_labels cost money (Step 1)
- Be conservative -- when in doubt, lean toward user reactions and note uncertainty
- Do NOT read transcript .jsonl files directly -- use list and expand
- Do NOT read source code or attempt to fix hooks
- Do NOT attempt to run tests
- ONLY use this MCP tool. Do NOT use any other tool (Read, Write, Edit, Bash, Grep, Glob)
`;
