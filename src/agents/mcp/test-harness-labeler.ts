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
import * as path from "path";
import { projectTranscriptFile, transcriptCacheDir, transcriptMcpStateFile } from "../../utils/paths.js";
import {
  findUnlabeledTranscripts,
  transcriptRunDir,
  testRunFileExists,
  readTestRunFile,
  readLabelFile,
  writeLabelFile,
  updateSingleLabel,
  updateLabelPrediction,
  updateMultipleLabels,
  setRichLabel,
  type LabelValue,
  type PredictionAnnotation,
  type RichExpectation,
  runReplayCommand,
  getVersion,
  checkAndIncrementRunLimit,
  rollbackRunLimit,
  detectWorkflowState,
  formatStatusFooter,
  appendTestRunFile,
  resolveTranscriptFromSession,
} from "./test-harness-shared.js";

/**
 * Return the canonical `expected` string for any LabelValue form. Used to
 * collapse rich vs string forms during the auto_label merge so the agree /
 * conflict branches operate on stable comparisons.
 */
function extractExpected(value: LabelValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const fullEntry = value.find((e) => (e.at ?? "full") === "full");
    return (fullEntry ?? value[0])?.expected ?? "";
  }
  return value.expected;
}

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
  const scaffoldLabels: Record<string, LabelValue> = { ...scaffoldData.labels };
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

  // Read generate_labels results (it overwrote labels.draft.json). Note:
  // generate_labels may emit RichExpectation entries when a deny carries a
  // prediction annotation. The merge below preserves rich-form so the
  // annotation survives.
  const genData = readLabelFile(transcriptName, true);
  const genLabels: Record<string, LabelValue> = genData.labels;
  const genReasoning = genData.reasoning ?? {};

  // Step 3: Merge — scaffold is baseline, hooks are advisory
  const mergedLabels: Record<string, LabelValue> = {};
  const mergedReasoning: Record<string, string> = {};
  let agreeCount = 0;
  let conflictCount = 0;

  const allKeys = new Set([...Object.keys(scaffoldLabels), ...Object.keys(genLabels)]);

  for (const key of allKeys) {
    const sVal = scaffoldLabels[key];
    const gVal = genLabels[key];
    const sReason = scaffoldReasoning[key] ?? "";
    const gReason = genReasoning[key] ?? "";
    const sExpected = extractExpected(sVal);
    const gExpected = extractExpected(gVal);

    if (sVal === undefined && gVal !== undefined) {
      // Preserve the generate_labels rich form (so prediction annotations
      // survive). Reasoning prints the canonical expected string, not
      // [object Object].
      mergedLabels[key] = gVal;
      mergedReasoning[key] = `[hooks-only] hook=${gExpected} (${gReason}). Not in scaffold.`;
      conflictCount++;
    } else if (sVal !== undefined && gVal === undefined) {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[scaffold-only] scaffold=${sExpected} (${sReason}). Not in hooks.`;
      conflictCount++;
    } else if (sExpected === "INVESTIGATE" || gExpected === "INVESTIGATE") {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[flagged] scaffold=${sExpected} (${sReason}) | hook=${gExpected} (${gReason})`;
      conflictCount++;
    } else if (sExpected === gExpected) {
      // Prefer the rich-form value when either side has it (preserves the
      // prediction annotation auto-populated by generate_labels).
      mergedLabels[key] = (typeof gVal === "object") ? gVal : sVal!;
      mergedReasoning[key] = `[agree] both=${sExpected}. scaffold: ${sReason} | hook: ${gReason}`;
      agreeCount++;
    } else {
      mergedLabels[key] = "INVESTIGATE";
      mergedReasoning[key] = `[CONFLICT] scaffold=${sExpected} (${sReason}) | hook=${gExpected} (${gReason}). Hooks are NOT authoritative.`;
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

  // Augment with prediction context when the target's label carries a
  // prediction annotation (or its tool-log entry's gate is prediction-block
  // / batch-sibling). Best-effort: if files don't exist, just skip.
  const predictionContext = collectPredictionContext(transcriptName, target);
  return output + (predictionContext ? "\n\n" + predictionContext : "") + formatStatusFooter(state);
}

/**
 * For the labeler's expand action: inspect labels.draft.json (or labels.json
 * if the draft is gone) and the cache's tool-log.jsonl + state.json's
 * `currentPrediction` for the target tool_use_id. When the target has a
 * prediction annotation OR its tool-log gate is prediction-block /
 * batch-sibling, return a multi-line description of the live prediction's
 * mood, trust, intent, blockedIntent, explicitlyAllowedTools, and
 * explicitlyBlockedSubstrings. Returns empty string when nothing is available.
 */
function collectPredictionContext(transcriptName: string, target: string): string {
  if (target.startsWith("stop:")) return "";
  // Read whichever label file exists.
  let labelFile: ReturnType<typeof readLabelFile> | null = null;
  try {
    labelFile = readLabelFile(transcriptName, true);
  } catch {
    try {
      labelFile = readLabelFile(transcriptName, false);
    } catch {
      labelFile = null;
    }
  }
  // Find the matching label entry. Honor the same prefix-match semantics as
  // replay.ts: keys >= 12 chars and target.startsWith(key) qualify.
  let matchedEntry: LabelValue | undefined;
  let matchedKey: string | undefined;
  if (labelFile) {
    if (labelFile.labels[target] !== undefined) {
      matchedEntry = labelFile.labels[target];
      matchedKey = target;
    } else {
      for (const [k, v] of Object.entries(labelFile.labels)) {
        if (k.length >= 12 && target.startsWith(k)) {
          matchedEntry = v;
          matchedKey = k;
          break;
        }
      }
    }
  }
  // Look up the tool-log entry for the target (gate field).
  let toolLogGate: string | undefined;
  let toolLogToolUseId: string | undefined;
  try {
    const toolLogPath = path.join(transcriptCacheDir(transcriptName), "tool-log.jsonl");
    const content = fs.readFileSync(toolLogPath, "utf-8");
    const logLines = content.split("\n").filter(Boolean);
    for (const line of logLines) {
      try {
        const entry = JSON.parse(line) as { toolUseId?: string; gate?: string };
        if (entry.toolUseId && (entry.toolUseId === target || target.startsWith(entry.toolUseId))) {
          toolLogGate = entry.gate;
          toolLogToolUseId = entry.toolUseId;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // No tool-log
  }
  // Determine whether this is a prediction-block / batch-sibling target.
  const labelHasPrediction = (() => {
    if (!matchedEntry || typeof matchedEntry === "string") return false;
    if (Array.isArray(matchedEntry)) {
      return matchedEntry.some((e) => e.prediction !== undefined);
    }
    return matchedEntry.prediction !== undefined;
  })();
  const isPredictionGate =
    toolLogGate === "prediction-block" || toolLogGate === "batch-sibling";
  if (!labelHasPrediction && !isPredictionGate) return "";

  const lines: string[] = [];
  lines.push("--- PREDICTION CONTEXT ---");
  if (matchedKey) lines.push(`Label key: ${matchedKey}`);
  if (toolLogGate) lines.push(`Tool-log gate: ${toolLogGate}`);
  if (matchedEntry && typeof matchedEntry !== "string") {
    const richArr = Array.isArray(matchedEntry) ? matchedEntry : [matchedEntry];
    for (const re of richArr) {
      if (re.prediction) {
        lines.push(
          `Annotation: verdict=${re.prediction.verdict}` +
            (re.prediction.intent_must_contain
              ? `, intent_must_contain="${re.prediction.intent_must_contain}"`
              : "") +
            (re.prediction.expected_mood
              ? `, expected_mood=${re.prediction.expected_mood}`
              : "") +
            (re.prediction.expected_trust
              ? `, expected_trust=${re.prediction.expected_trust}`
              : "") +
            (re.prediction.forbidden_blocks?.length
              ? `, forbidden_blocks=${JSON.stringify(re.prediction.forbidden_blocks)}`
              : "") +
            (re.prediction.notes ? `, notes="${re.prediction.notes}"` : ""),
        );
      }
    }
  }
  // Read state.json for live currentPrediction details.
  try {
    const statePath = path.join(transcriptCacheDir(transcriptName), "state.json");
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      data?: {
        currentPrediction?: {
          mood?: string;
          trust?: string;
          intent?: string;
          blockedIntent?: string;
          explicitlyAllowedTools?: string[];
          explicitlyBlockedSubstrings?: Array<{
            tool?: string;
            targetSubstring?: string;
            reason?: string;
          }>;
        } | null;
      };
    };
    const live = parsed.data?.currentPrediction ?? null;
    if (live) {
      lines.push("");
      lines.push("Live currentPrediction:");
      lines.push(`  mood: ${live.mood ?? "(unset)"}`);
      lines.push(`  trust: ${live.trust ?? "(unset)"}`);
      if (live.intent) lines.push(`  intent: ${live.intent}`);
      if (live.blockedIntent) lines.push(`  blockedIntent: ${live.blockedIntent}`);
      if (live.explicitlyAllowedTools && live.explicitlyAllowedTools.length > 0) {
        lines.push(`  explicitlyAllowedTools: ${live.explicitlyAllowedTools.join(", ")}`);
      }
      if (live.explicitlyBlockedSubstrings && live.explicitlyBlockedSubstrings.length > 0) {
        lines.push(
          `  explicitlyBlockedSubstrings: ${JSON.stringify(live.explicitlyBlockedSubstrings)}`,
        );
      }
    }
  } catch {
    // No state.json or parse error — just emit what we have
  }
  if (toolLogToolUseId) {
    lines.push(`Source tool_use_id: ${toolLogToolUseId}`);
  }
  return lines.join("\n");
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

function handleUpdateLabelPrediction(
  transcriptName: string,
  key: string,
  prediction: PredictionAnnotation,
  reasoning: string,
): string {
  updateLabelPrediction(transcriptName, key, prediction, reasoning);
  const state = detectWorkflowState(transcriptName);
  const desc =
    `verdict=${prediction.verdict}` +
    (prediction.forbidden_blocks?.length
      ? `, forbidden_blocks=${prediction.forbidden_blocks.length}`
      : "") +
    (prediction.intent_must_contain ? `, intent_must_contain set` : "");
  return `Updated prediction annotation for "${key}" (${desc})` + formatStatusFooter(state);
}

function handleUpdateLabelPredictions(
  transcriptName: string,
  updates: Array<{
    key: string;
    verdict: PredictionAnnotation["verdict"];
    forbidden_blocks?: PredictionAnnotation["forbidden_blocks"];
    intent_must_contain?: string;
    notes?: string;
    reasoning: string;
  }>,
): string {
  for (const u of updates) {
    const annotation: PredictionAnnotation = { verdict: u.verdict };
    if (u.forbidden_blocks !== undefined) annotation.forbidden_blocks = u.forbidden_blocks;
    if (u.intent_must_contain !== undefined) annotation.intent_must_contain = u.intent_must_contain;
    if (u.notes !== undefined) annotation.notes = u.notes;
    updateLabelPrediction(transcriptName, u.key, annotation, u.reasoning);
  }
  const state = detectWorkflowState(transcriptName);
  return `Updated ${updates.length} prediction annotations.` + formatStatusFooter(state);
}

/**
 * Reset a transcript's mcp-state.json and cache/ directory so auto_label /
 * generate_labels can be re-run. Does NOT touch labels.json,
 * labels.draft.json, or notes_and_questions.md.
 */
function handleResetForRelabel(transcriptName: string): string {
  const removed: string[] = [];
  try {
    fs.unlinkSync(transcriptMcpStateFile(transcriptName));
    removed.push("mcp-state.json");
  } catch {
    // Not present — nothing to remove
  }
  try {
    fs.rmSync(transcriptCacheDir(transcriptName), { recursive: true, force: true });
    removed.push("cache/");
  } catch {
    // Not present
  }
  const state = detectWorkflowState(transcriptName);
  return (
    `Reset for re-label of "${transcriptName}":\n` +
    `  Removed: ${removed.length > 0 ? removed.join(", ") : "(nothing — already clean)"}\n` +
    `  Preserved: labels.json, labels.draft.json, notes_and_questions.md (if any)\n` +
    `  You can now re-run auto_label or generate_labels.` +
    formatStatusFooter(state)
  );
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
  // Try sidecar resolution for session-folder names ({ts}_{hash} pattern)
  if (/^\d{4}-\d{2}-\d{2}-\d{4}_[0-9a-f]+$/.test(transcriptName)) {
    const sidecarPath = resolveTranscriptFromSession(transcriptName);
    if (sidecarPath) {
      return sidecarPath;
    }
  }
  // For generate_labels/scaffold, use original transcript from project dir
  const projectPath = projectTranscriptFile(transcriptName);
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
    `If the transcript lives outside the default project transcripts directory, ` +
    `pass "transcript_path" to point at the file directly, or pass the session ` +
    `folder name (e.g. "2025-01-15-1430_abc12345") to resolve via the session sidecar.`,
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
  // Try sidecar resolution for session-folder names ({ts}_{hash} pattern)
  if (/^\d{4}-\d{2}-\d{2}-\d{4}_[0-9a-f]+$/.test(transcriptName)) {
    const sidecarPath = resolveTranscriptFromSession(transcriptName);
    if (sidecarPath) {
      return sidecarPath;
    }
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
   * Shape: { expected, by?, at?, notes?, prediction? }. See
   * test-harness-shared.ts:RichExpectation for the full contract.
   */
  expectation?: RichExpectation | RichExpectation[];
  /**
   * For update_label_prediction: hindsight verdict on the prediction that
   * caused this deny. Required when calling update_label_prediction.
   */
  verdict?: PredictionAnnotation["verdict"];
  /**
   * For update_label_prediction: list of forbidden filters when verdict is
   * "too_broad". Each filter's `tool` must be a LITERAL tool name (no regex
   * metachars).
   */
  forbidden_blocks?: PredictionAnnotation["forbidden_blocks"];
  /**
   * For update_label_prediction: substring that must appear in the live
   * prediction's blockedIntent.
   */
  intent_must_contain?: string;
  /**
   * For update_label_predictions: batch updates of prediction annotations.
   */
  prediction_updates?: Array<{
    key: string;
    verdict: PredictionAnnotation["verdict"];
    forbidden_blocks?: PredictionAnnotation["forbidden_blocks"];
    intent_must_contain?: string;
    notes?: string;
    reasoning: string;
  }>;
  /**
   * Absolute path to the transcript .jsonl file. Use when the transcript
   * lives outside the default project transcripts directory (e.g. a session
   * from another project). Applies to auto_label / generate_labels / scaffold /
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

      case "update_label_prediction": {
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (!input.key) throw new Error("key is required");
        if (!input.verdict) throw new Error("verdict is required (correct/too_broad/wrong/INVESTIGATE)");
        if (!input.reasoning) throw new Error("reasoning is required");
        const annotation: PredictionAnnotation = { verdict: input.verdict };
        if (input.forbidden_blocks !== undefined) annotation.forbidden_blocks = input.forbidden_blocks;
        if (input.intent_must_contain !== undefined) annotation.intent_must_contain = input.intent_must_contain;
        return handleUpdateLabelPrediction(input.transcript_name, input.key, annotation, input.reasoning);
      }

      case "update_label_predictions":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        if (
          !input.prediction_updates ||
          !Array.isArray(input.prediction_updates) ||
          input.prediction_updates.length === 0
        ) {
          throw new Error("prediction_updates array is required and must be non-empty");
        }
        return handleUpdateLabelPredictions(input.transcript_name, input.prediction_updates);

      case "reset_for_relabel":
        if (!input.transcript_name) throw new Error("transcript_name is required");
        return handleResetForRelabel(input.transcript_name);

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
          "update_label, update_labels, set_label, update_label_prediction, update_label_predictions, " +
          "reset_for_relabel, finalize, read_file, append_notes, git_hash, help"
        );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `ERROR: ${message}`;
  }
}

// ─── Help Documentation ────────────────────────────────────────────────────

export const LABELER_HELP = `# Test Harness Labeler -- Complete Reference

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

For tool labels with \`gate: prediction-block\` or \`gate: batch-sibling\`, the
auto-labeler attaches a \`prediction\` annotation with verdict "correct" by default.
Use expand <tool_use_id> to see the prediction's mood, trust, intent, blockedIntent,
explicitlyAllowedTools, and explicitlyBlockedSubstrings alongside the surrounding transcript.

Apply the trust hierarchy:
- User said the block was wrong (looksNegative + reaction text mentions the block)
  -> set verdict "wrong"; the prediction should not have fired
- User asked the AI to retry on a narrower target after the block (or you can see
  this is over-blocking by inspecting the prediction's explicitlyBlockedSubstrings
  against the original tool input)
  -> set verdict "too_broad" and provide forbidden_blocks: the LITERAL
    {tool, target_pattern} filters the prediction must NOT match after narrowing.
- AI complained but user was silent -> keep verdict "correct" (skeptical of AI)
- Silence after block -> keep verdict "correct" (auto-default)

Use update_label_prediction to set the verdict.

### Mood verdicts

The auto-labeler also auto-populates \`expected_mood\` from the live prediction
(angry/frustrated/neutral/satisfied/happy). Override it when the live mood is
clearly miscalibrated relative to the user's actual tone in the surrounding
transcript. The semantics of \`intent_must_contain\` shifted: it now matches
the live prediction's \`intent\` field (what the user wants), not the legacy
\`blockedIntent\` field. Re-labeling existing transcripts may produce different
auto-populated excerpts.

### Re-labeling existing transcripts
Action: reset_for_relabel (transcript_name)
Removes mcp-state.json and cache/ for the given transcript so auto_label and
generate_labels can be re-run. Preserves labels.json, labels.draft.json, and
notes_and_questions.md. Use this if you need to re-run hook replay after a
prediction-cache or prediction-rule change.

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

- auto_label and generate_labels cost real money. Run ONCE per transcript by
  default. Re-running is only allowed via the explicit reset_for_relabel MCP
  action -- direct re-invocation of auto_label without reset is forbidden.
- list, expand, validate are FREE (no LLM calls, no cost)
- Only auto_label and generate_labels cost money (Step 1)
- Be conservative -- when in doubt, lean toward user reactions and note uncertainty
- Do NOT read transcript .jsonl files directly -- use list and expand
- Do NOT read source code or attempt to fix hooks
- Do NOT attempt to run tests
- ONLY use this MCP tool. Do NOT use any other tool (Read, Write, Edit, Bash).
`;
