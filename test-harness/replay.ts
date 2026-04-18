#!/usr/bin/env npx tsx
/**
 * Transcript Replay — full session replay through the real hook system.
 *
 * Reads a JSONL transcript, creates a test-run session directory,
 * fires session-start, then walks each line firing the appropriate
 * hook. State accumulates naturally across calls.
 *
 * Usage:
 *   npx tsx test-harness/replay.ts --transcript <path.jsonl> [--expect '<json>'] [--cwd <dir>] [--timeout 60000]
 *
 * Exit codes: 0 = all scored passed (or no expectations), 1 = any scored failed, 2 = error
 *
 * @module test-harness/replay
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  LivePredictionSnapshot,
  ReplayEvent,
  ReplayExpectations,
  ReplayArgs,
  RichExpectation,
  normalizeExpectation,
} from "./lib/types.js";
import { runCommand } from "../src/utils/command.js";
import { classifyLine, extractCwd, detectBatches, type BatchGroup } from "./lib/classifier.js";
import { runHook } from "./lib/harness.js";
import {
  REPO_ROOT,
  findActivePredictionMatching,
  getVersion,
  hookScript,
  buildEnv,
  readLastToolLogEntry,
  parsePreToolUseDecision,
  parseStopDecision,
  scoreRichExpectation,
} from "./lib/hook-runner.js";
import { readToolLogEntries, type ToolLogEntry } from "../src/utils/session-store.js";
import type { LabelValue } from "../src/agents/mcp/test-harness-shared.js";

const BASE_DIR = path.join(os.homedir(), ".agent-framework");
const TEST_RUNS_DIR = path.join(BASE_DIR, "test-runs");
const MIN_PREFIX_LENGTH = 12;

function transcriptSlug(transcriptPath: string): string {
  return path.basename(transcriptPath, ".jsonl");
}

function transcriptDir(transcriptPath: string): string {
  return path.join(TEST_RUNS_DIR, transcriptSlug(transcriptPath));
}

function cacheDir(transcriptPath: string): string {
  return path.join(transcriptDir(transcriptPath), "cache");
}

// ─── Arg Parsing ────────────────────────────────────────────────────────────

function parseArgs(): ReplayArgs {
  const args = process.argv.slice(2);

  function getArg(name: string, required: boolean = false): string | undefined {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) {
      if (required) {
        console.error(`Error: --${name} is required`);
        process.exit(2);
      }
      return undefined;
    }
    return args[idx + 1];
  }

  const list = args.includes("--list");
  const scaffold = args.includes("--scaffold");
  const validate = args.includes("--validate");
  const generateLabels = args.includes("--generate-labels");
  const expand = getArg("expand");
  const depthRaw = getArg("depth");
  const depth = depthRaw ? parseInt(depthRaw, 10) : 1;
  const transcript = getArg("transcript", true)!;
  const timeoutRaw = getArg("timeout");
  const timeout = timeoutRaw ? parseInt(timeoutRaw, 10) : 60000;
  const cwd = getArg("cwd");
  const filter = getArg("filter");
  const truncateToLineRaw = getArg("truncate-to-line");
  const truncateToLine = truncateToLineRaw
    ? parseInt(truncateToLineRaw, 10)
    : undefined;
  if (truncateToLine !== undefined) {
    if (!Number.isFinite(truncateToLine) || truncateToLine < 1) {
      console.error(
        `Error: --truncate-to-line must be a positive 1-based integer, got "${truncateToLineRaw}"`,
      );
      process.exit(2);
    }
    if (!filter) {
      console.error(
        "Error: --truncate-to-line requires --filter to target a single hook",
      );
      process.exit(2);
    }
  }

  let expect: ReplayExpectations | undefined;
  const expectRaw = getArg("expect");
  if (expectRaw) {
    if (!expectRaw.endsWith(".json")) {
      console.error(
        "ERROR: --expect requires a path to a .json file. Inline JSON is not supported.\n\n" +
        "  Store labels at: ~/.agent-framework/test-runs/<name>/labels.json\n" +
        "  Use --scaffold to generate a starter file with all keys pre-filled.\n"
      );
      process.exit(2);
    }
    try {
      const fileContent = fs.readFileSync(expectRaw, "utf-8");
      const parsed = JSON.parse(fileContent);
      expect = parsed.labels ?? parsed;
    } catch (err) {
      console.error(
        `ERROR: Cannot read label file: ${expectRaw}\n` +
        `  ${err instanceof Error ? err.message : String(err)}\n\n` +
        "  Use --scaffold to generate a starter label file.\n"
      );
      process.exit(2);
    }
  }

  return { transcript, expect, expectPath: expectRaw, cwd, timeout, list, expand, depth, scaffold, validate, generateLabels, filter, truncateToLine };
}

// ─── Expectation Matching ───────────────────────────────────────────────────

/**
 * Look up the label entry for a key, handling prefix matches and returning
 * the raw entry without normalization (so callers can distinguish "no label"
 * from "label found but rich").
 */
function findExpectationEntry(
  expectations: ReplayExpectations | undefined,
  key: string,
): ReplayExpectations[string] | undefined {
  if (!expectations) return undefined;
  if (expectations[key] !== undefined) return expectations[key];
  for (const [prefix, value] of Object.entries(expectations)) {
    if (prefix.length >= MIN_PREFIX_LENGTH && key.startsWith(prefix)) {
      return value;
    }
  }
  return undefined;
}

/**
 * Normalize the label entry for a key into an array of RichExpectation.
 * Legacy string labels become `[{ expected: "<value>" }]`. Returns [] when
 * no label is present.
 */
function matchExpectation(
  expectations: ReplayExpectations | undefined,
  key: string,
): RichExpectation[] {
  return normalizeExpectation(findExpectationEntry(expectations, key));
}

/**
 * Filter a normalized expectation list by the current run's truncation.
 * A rich entry with `at: number | "full"` is only in scope when it matches
 * the run's truncation setting; an entry with no `at` always applies to
 * full-file runs (the default) and never to truncated runs.
 */
function scopedExpectations(
  expectations: RichExpectation[],
  truncateToLine: number | undefined,
): RichExpectation[] {
  const runAt: number | "full" = truncateToLine ?? "full";
  return expectations.filter((e) => {
    const entryAt: number | "full" = e.at ?? "full";
    return entryAt === runAt;
  });
}

// ─── Scorable Key Collection ───────────────────────────────────────────────

function collectScorableKeys(
  lines: Record<string, unknown>[]
): Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }> {
  const keys: Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const classification = classifyLine(lines[i], lines, i);
    if (classification.kind === "pre-tool-use") {
      for (const block of classification.blocks) {
        keys.push({ key: block.id, line: i, type: "tool_use", tool: block.name });
      }
    }
    if (classification.kind === "stop-response-check") {
      keys.push({ key: `stop:${i}`, line: i, type: "stop" });
    }
  }
  return keys;
}

// ─── Expectation Validation ────────────────────────────────────────────────

function validateExpectationCompleteness(
  expectations: ReplayExpectations,
  scorableKeys: Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }>,
  batchMap?: Map<string, BatchGroup>,
): void {
  const unlabeled = scorableKeys.filter(
    (sk) => matchExpectation(expectations, sk.key).length === 0,
  );
  const expectKeys = Object.keys(expectations).filter((k) => !k.startsWith("_"));
  const orphaned = expectKeys.filter((ek) => {
    return !scorableKeys.some((sk) =>
      sk.key === ek || (ek.length >= MIN_PREFIX_LENGTH && sk.key.startsWith(ek))
    );
  });

  // Unwrap rich expectations. Only consider the full-file ("at" absent or
  // "full") slice for INVESTIGATE / invalid-value checks, since truncation-
  // scoped entries are effectively extra assertions layered on top of a
  // full-file label and are allowed to omit the default "full" variant.
  const entriesNormalized: Array<{
    key: string;
    expected: string;
    by?: string;
    at?: number | "full";
  }> = [];
  for (const [k, raw] of Object.entries(expectations)) {
    if (k.startsWith("_")) continue;
    for (const e of normalizeExpectation(raw)) {
      entriesNormalized.push({ key: k, expected: e.expected, by: e.by, at: e.at });
    }
  }

  // Check for unresolved INVESTIGATE values.
  const unresolved = entriesNormalized.filter((e) => e.expected === "INVESTIGATE");

  // Check for invalid label values on the "full" (or unspecified) slice.
  const invalidValues = entriesNormalized.filter((e) => {
    const at = e.at ?? "full";
    if (at !== "full") return false;
    if (e.key.startsWith("stop:")) return !["pass", "block"].includes(e.expected);
    return !["allow", "deny"].includes(e.expected);
  });

  // Rich-only: `by` must be a non-empty string when present.
  const invalidBy = entriesNormalized.filter(
    (e) => e.by !== undefined && (typeof e.by !== "string" || e.by.length === 0),
  );

  // Rich-only: `at` must be "full" or a positive integer when present.
  const invalidAt = entriesNormalized.filter(
    (e) =>
      e.at !== undefined &&
      e.at !== "full" &&
      !(typeof e.at === "number" && Number.isFinite(e.at) && e.at >= 1),
  );

  // Check batch label consistency on the full-file slice only.
  const fullExpectedFor = (key: string): string | undefined => {
    const matches = matchExpectation(expectations, key);
    const fullMatch = matches.find((e) => (e.at ?? "full") === "full");
    return fullMatch?.expected;
  };
  const batchMismatches: Array<{ siblingId: string; siblingLabel: string; leaderId: string; leaderLabel: string }> = [];
  if (batchMap) {
    const seen = new Set<string>();
    for (const [toolUseId, group] of batchMap) {
      if (seen.has(group.toolUseIds[0])) continue;
      seen.add(group.toolUseIds[0]);
      const leaderLabel = fullExpectedFor(group.toolUseIds[0]);
      if (!leaderLabel) continue;
      for (let idx = 1; idx < group.toolUseIds.length; idx++) {
        const siblingLabel = fullExpectedFor(group.toolUseIds[idx]);
        if (siblingLabel && siblingLabel !== leaderLabel) {
          batchMismatches.push({
            siblingId: group.toolUseIds[idx],
            siblingLabel,
            leaderId: group.toolUseIds[0],
            leaderLabel,
          });
        }
      }
    }
  }

  if (
    unlabeled.length === 0 &&
    orphaned.length === 0 &&
    invalidValues.length === 0 &&
    invalidBy.length === 0 &&
    invalidAt.length === 0 &&
    batchMismatches.length === 0
  ) return;

  const total = scorableKeys.length;
  const labeled = total - unlabeled.length;
  const msg: string[] = [];

  msg.push("");
  msg.push(`ERROR: Incomplete label set — ${labeled} of ${total} scorable hooks labeled.`);
  msg.push("");

  if (unlabeled.length > 0) {
    msg.push(`UNLABELED HOOKS (${unlabeled.length}) — add a label for each:`);
    msg.push("");
    for (const u of unlabeled) {
      const defaultVal = u.type === "tool_use" ? "allow" : "pass";
      const desc = u.type === "tool_use" ? `tool: ${u.tool}` : "stop point";
      msg.push(`  "${u.key}": "${defaultVal}"    (line ${u.line}, ${desc})`);
    }
    msg.push("");
  }

  if (orphaned.length > 0) {
    msg.push(`ORPHANED KEYS (${orphaned.length}) — no matching hook, remove from label file:`);
    for (const o of orphaned) msg.push(`  "${o}"`);
    msg.push("");
  }

  if (unresolved.length > 0) {
    msg.push(`UNRESOLVED (${unresolved.length}) — still marked "INVESTIGATE", must be "allow"/"deny" or "pass"/"block":`);
    for (const u of unresolved) msg.push(`  "${u.key}"`);
    msg.push("");
  }

  if (invalidValues.length > 0) {
    msg.push(`INVALID VALUES (${invalidValues.length}) — tool labels must be "allow"/"deny", stop labels "pass"/"block":`);
    for (const v of invalidValues) msg.push(`  "${v.key}": "${v.expected}"`);
    msg.push("");
  }

  if (invalidBy.length > 0) {
    msg.push(`INVALID "by" (${invalidBy.length}) — rich expectations with "by" must provide a non-empty rule name:`);
    for (const v of invalidBy) msg.push(`  "${v.key}": by=${JSON.stringify(v.by)}`);
    msg.push("");
  }

  if (invalidAt.length > 0) {
    msg.push(`INVALID "at" (${invalidAt.length}) — rich expectations with "at" must be a positive integer or "full":`);
    for (const v of invalidAt) msg.push(`  "${v.key}": at=${JSON.stringify(v.at)}`);
    msg.push("");
  }

  if (batchMismatches.length > 0) {
    msg.push(`BATCH LABEL MISMATCHES (${batchMismatches.length}) — sibling labels must match leader:`);
    for (const m of batchMismatches) {
      msg.push(`  "${m.siblingId}" is "${m.siblingLabel}" but leader "${m.leaderId}" is "${m.leaderLabel}"`);
    }
    msg.push("");
  }

  msg.push("HOW TO FIX:");
  msg.push("  1. Run --scaffold to generate a starter label file with all keys pre-filled");
  msg.push("  2. Run --list to see all scorable hooks with user reactions");
  msg.push("  3. Positive user reaction (continues normally) -> \"allow\" for tools, \"pass\" for stops");
  msg.push("  4. Negative user reaction -> run --expand <id> to investigate, then \"deny\" or \"block\"");
  msg.push("  5. EVERY tool call and stop point must be labeled. No exceptions.");
  msg.push("");

  console.error(msg.join("\n"));
  process.exit(2);
}

// ─── Negative Reaction Detection ───────────────────────────────────────────

function looksNegative(reaction: string): boolean {
  const lower = reaction.toLowerCase();
  const patterns = [
    "what the", "why did", "why are you", "don't", "dont", "stop",
    "wrong", "fuck", "shit", "damn", "ugh", "not what", "didn't ask",
    "didnt ask", "cancel", "undo", "revert", "i said", "that's not",
    "thats not", "you forgot", "you missed", "you should have",
    "no ", "broke", "break", "mistake", "error",
  ];
  return patterns.some((p) => lower.includes(p));
}

// ─── Batch leader lookup ───────────────────────────────────────────────────

/**
 * Find the leader gate of the batch this entry belongs to.
 * - If the entry has no batchPosition or is at position 0, returns the
 *   entry's own gate.
 * - Otherwise walks back through `toolLog` (bounded to entry.batchSize
 *   entries) to find the most recent prior entry with the same batchSize
 *   AND batchPosition === 0; returns that entry's gate.
 * - Returns undefined if the leader cannot be found within the bound.
 */
function getBatchLeaderGate(
  toolLog: ToolLogEntry[],
  entry: ToolLogEntry,
): string | undefined {
  if (entry.batchPosition === undefined || entry.batchPosition === 0) {
    return entry.gate;
  }
  const bound = entry.batchSize ?? 0;
  // Find entry's index in the log; walk back at most `bound` entries.
  const idx = toolLog.lastIndexOf(entry);
  if (idx === -1) return undefined;
  const start = Math.max(0, idx - bound);
  for (let j = idx - 1; j >= start; j--) {
    const candidate = toolLog[j];
    if (
      candidate.batchSize === entry.batchSize &&
      candidate.batchPosition === 0
    ) {
      return candidate.gate;
    }
  }
  return undefined;
}

/**
 * Find the leader's tool name and input by walking the tool-log back the
 * same way, then correlating via `toolUseMap`. Returns null when the
 * leader entry cannot be located OR when the leader's toolUseId isn't in
 * the map (e.g. transcript was malformed).
 */
function getBatchLeaderToolInfo(
  toolLog: ToolLogEntry[],
  entry: ToolLogEntry,
  toolUseMap: Map<string, { name: string; input: unknown }>,
): { toolName: string; toolInput: unknown } | null {
  if (entry.batchPosition === undefined || entry.batchPosition === 0) {
    if (entry.toolUseId) {
      const info = toolUseMap.get(entry.toolUseId);
      if (info) return { toolName: info.name, toolInput: info.input };
    }
    return null;
  }
  const bound = entry.batchSize ?? 0;
  const idx = toolLog.lastIndexOf(entry);
  if (idx === -1) return null;
  const start = Math.max(0, idx - bound);
  for (let j = idx - 1; j >= start; j--) {
    const candidate = toolLog[j];
    if (
      candidate.batchSize === entry.batchSize &&
      candidate.batchPosition === 0
    ) {
      if (!candidate.toolUseId) return null;
      const info = toolUseMap.get(candidate.toolUseId);
      if (!info) return null;
      return { toolName: info.name, toolInput: info.input };
    }
  }
  return null;
}

// ─── Stale Sweep ────────────────────────────────────────────────────────────

function sweepStaleCaches(): void {
  try {
    const entries = fs.readdirSync(TEST_RUNS_DIR);
    const oneHourAgo = Date.now() - 60 * 60 * 1000;

    for (const entry of entries) {
      const cachePath = path.join(TEST_RUNS_DIR, entry, "cache");
      try {
        const stat = fs.statSync(cachePath);
        if (stat.mtimeMs > oneHourAgo) continue;

        // Check if replay.pid exists and process is alive
        const pidFile = path.join(cachePath, "replay.pid");
        try {
          const pidContent = fs.readFileSync(pidFile, "utf-8").trim();
          const pid = parseInt(pidContent, 10);
          if (!isNaN(pid)) {
            try {
              process.kill(pid, 0);
              // Process is alive — skip this cache
              continue;
            } catch {
              // Process is dead — safe to remove
            }
          }
        } catch {
          // No replay.pid — safe to remove
        }

        fs.rmSync(cachePath, { recursive: true, force: true });
      } catch {
        // Skip entries without cache dir
      }
    }
  } catch {
    // No test-runs dir yet
  }
}

// ─── List Mode ─────────────────────────────────────────────────────────────

/**
 * Find the next real user prompt after a given line index.
 * Skips tool_result messages and system-injected (isMeta) messages.
 * Stops at the next scorable assistant event (tool_use or stop point) since
 * the user reaction beyond that boundary is about the later actions, not ours.
 * Returns the prompt text (truncated to 200 chars) or undefined.
 */
function findNextUserReaction(lines: Record<string, unknown>[], afterIndex: number): string | undefined {
  for (let j = afterIndex + 1; j < lines.length; j++) {
    const line = lines[j];

    // Stop at the next assistant turn with tool calls or a stop point.
    // If the assistant made more tool calls after ours, the eventual user
    // reaction is about those later calls, not ours.
    if (line.type === "assistant") {
      const classification = classifyLine(line, lines, j);
      if (classification.kind === "pre-tool-use" || classification.kind === "stop-response-check") {
        return undefined;
      }
      continue;
    }

    if (line.type !== "user" || line.isMeta === true) continue;

    const message = line.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Skip tool_result messages
    if (Array.isArray(content)) {
      const hasToolResult = content.some(
        (block: Record<string, unknown>) => block.type === "tool_result"
      );
      if (hasToolResult) continue;

      const textBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === "text"
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n");
        return text.slice(0, 200);
      }
    }

    if (typeof content === "string" && content.length > 0) {
      return content.slice(0, 200);
    }
  }
  return undefined;
}

/**
 * Summarize a transcript line into a compact context entry.
 */
function summarizeLine(lines: Record<string, unknown>[], index: number): Record<string, unknown> | null {
  const line = lines[index];
  const type = line.type as string | undefined;
  if (!type) return null;

  const classification = classifyLine(line, lines, index);
  const message = line.message as Record<string, unknown> | undefined;
  const content = message?.content;

  if (classification.kind === "pre-tool-use") {
    return {
      line: index,
      role: "assistant",
      type: "tool_use",
      tools: classification.blocks.map((b) => ({ tool: b.name, id: b.id })),
    };
  }

  if (classification.kind === "stop-response-check") {
    let text: string | undefined;
    if (Array.isArray(content)) {
      const textBlocks = content.filter((b: Record<string, unknown>) => b.type === "text");
      if (textBlocks.length > 0) {
        text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n").slice(0, 300);
      }
    }
    return { line: index, role: "assistant", type: "stop", text };
  }

  if (classification.kind === "post-tool-use") {
    return {
      line: index,
      role: "tool_result",
      type: "tool_result",
      tool_use_ids: classification.results.map((r) => r.tool_use_id),
    };
  }

  if (classification.kind === "user-prompt-submit") {
    return { line: index, role: "user", type: "prompt", text: classification.prompt.slice(0, 300) };
  }

  // For assistant lines that aren't tool_use or stop (e.g. thinking, streaming chunks)
  if (type === "assistant") {
    let text: string | undefined;
    if (Array.isArray(content)) {
      const textBlocks = content.filter((b: Record<string, unknown>) => b.type === "text");
      if (textBlocks.length > 0) {
        text = textBlocks.map((b: Record<string, unknown>) => b.text as string).join("\n").slice(0, 300);
      }
    }
    if (text) return { line: index, role: "assistant", type: "text", text };
  }

  return null;
}

/**
 * List all tool calls and stop points with the next user reaction.
 */
function listToolCalls(lines: Record<string, unknown>[], batchMap: Map<string, BatchGroup>): void {
  let count = 0;
  let investigateCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const classification = classifyLine(lines[i], lines, i);

    if (classification.kind === "pre-tool-use") {
      const reaction = findNextUserReaction(lines, i);
      for (const block of classification.blocks) {
        const isNeg = reaction ? looksNegative(reaction) : false;
        const suggested = isNeg ? "INVESTIGATE" : "allow";
        if (isNeg) investigateCount++;
        const entry: Record<string, unknown> = {
          line: i,
          type: "tool_use",
          tool: block.name,
          id: block.id,
          suggested_label: suggested,
        };
        const batch = batchMap.get(block.id);
        if (batch) {
          const pos = batch.toolUseIds.indexOf(block.id);
          entry.batch_position = pos;
          entry.batch_size = batch.toolUseIds.length;
          entry.batch_leader = batch.toolUseIds[0];
        }
        if (reaction) entry.user_reaction = reaction;
        console.log(JSON.stringify(entry));
        count++;
      }
    }

    if (classification.kind === "stop-response-check") {
      const reaction = findNextUserReaction(lines, i);
      const isNeg = reaction ? looksNegative(reaction) : false;
      const suggested = isNeg ? "INVESTIGATE" : "pass";
      if (isNeg) investigateCount++;
      const entry: Record<string, unknown> = {
        line: i,
        type: "stop",
        key: `stop:${i}`,
        suggested_label: suggested,
      };
      if (reaction) entry.user_reaction = reaction;
      console.log(JSON.stringify(entry));
      count++;
    }
  }

  console.error(
    `\n${count} scorable hooks found (${investigateCount} flagged INVESTIGATE).` +
    ` Use --scaffold to generate a starter label file.\n`
  );
}

/**
 * Generate a starter label file with all scorable keys pre-filled.
 */
function scaffoldLabelFile(
  lines: Record<string, unknown>[],
  transcriptPath: string,
  scorableKeys: Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }>,
  batchMap: Map<string, BatchGroup>,
): void {
  const tDir = transcriptDir(transcriptPath);
  const labelPath = path.join(tDir, "labels.draft.json");

  // Create transcript dir and copy transcript if not present
  fs.mkdirSync(tDir, { recursive: true });
  const transcriptCopy = path.join(tDir, "transcript.jsonl");
  if (!fs.existsSync(transcriptCopy)) {
    fs.copyFileSync(transcriptPath, transcriptCopy);
  }

  const labels: Record<string, string> = {};
  const reasoning: Record<string, string> = {};
  let investigateCount = 0;

  for (const sk of scorableKeys) {
    const reaction = findNextUserReaction(lines, sk.line);
    const isNeg = reaction ? looksNegative(reaction) : false;
    if (sk.type === "tool_use") {
      const batch = batchMap.get(sk.key);
      const batchPos = batch ? batch.toolUseIds.indexOf(sk.key) : -1;
      labels[sk.key] = isNeg ? "INVESTIGATE" : "allow";
      if (batch && batchPos > 0) {
        reasoning[sk.key] = `Batch sibling (pos ${batchPos}/${batch.toolUseIds.length}) — label must match leader ${batch.toolUseIds[0]}`;
      } else {
        reasoning[sk.key] = isNeg
          ? `Negative reaction detected: "${reaction?.slice(0, 100)}"`
          : reaction
            ? "User continued normally"
            : "No user reaction found";
      }
    } else {
      labels[sk.key] = isNeg ? "INVESTIGATE" : "pass";
      reasoning[sk.key] = isNeg
        ? `Negative reaction detected: "${reaction?.slice(0, 100)}"`
        : reaction
          ? "User continued with new input"
          : "End of transcript or no reaction";
    }
    if (isNeg) investigateCount++;
  }

  const output = {
    _meta: {
      transcript: transcriptPath,
      created: new Date().toISOString(),
      commit: getVersion(),
      total_hooks: scorableKeys.length,
      needs_review: investigateCount,
    },
    labels,
    reasoning,
  };

  fs.writeFileSync(labelPath, JSON.stringify(output, null, 2) + "\n");

  console.log(labelPath);
  console.error(
    `\nScaffold written: ${scorableKeys.length} hooks (${investigateCount} flagged INVESTIGATE)\n` +
    `  File: ${labelPath}\n\n` +
    "Next steps:\n" +
    "  1. Review items marked \"INVESTIGATE\" — use --expand <id> for context\n" +
    "  2. Change each \"INVESTIGATE\" to \"allow\"/\"deny\" (tools) or \"pass\"/\"block\" (stops)\n" +
    "  3. Run --validate to check completeness\n" +
    `  4. Rename labels.draft.json to labels.json when done\n` +
    `  5. Run replay: npx tsx test-harness/replay.ts --transcript ${transcriptPath} --expect ${labelPath}\n`
  );
}

/**
 * Validate a label file for completeness and correctness without running hooks.
 */
function validateLabelFile(
  expectations: ReplayExpectations,
  scorableKeys: Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }>,
): void {
  const unlabeled = scorableKeys.filter(
    (sk) => matchExpectation(expectations, sk.key).length === 0,
  );
  const expectKeys = Object.keys(expectations).filter((k) => !k.startsWith("_"));
  const orphaned = expectKeys.filter((ek) => {
    return !scorableKeys.some((sk) =>
      sk.key === ek || (ek.length >= MIN_PREFIX_LENGTH && sk.key.startsWith(ek))
    );
  });

  const invalidValues: Array<{ key: string; value: string | number | "full" | undefined }> = [];
  for (const [k, raw] of Object.entries(expectations)) {
    if (k.startsWith("_")) continue;
    for (const e of normalizeExpectation(raw)) {
      const at = e.at ?? "full";
      if (at !== "full") continue; // truncation-scoped entries aren't validated for value shape
      const isValid = k.startsWith("stop:")
        ? ["pass", "block"].includes(e.expected)
        : ["allow", "deny"].includes(e.expected);
      if (!isValid) invalidValues.push({ key: k, value: e.expected });
      if (e.by !== undefined && (typeof e.by !== "string" || e.by.length === 0)) {
        invalidValues.push({ key: k, value: `by=${JSON.stringify(e.by)}` });
      }
    }
  }

  const valid = unlabeled.length === 0 && orphaned.length === 0 && invalidValues.length === 0;

  const result: Record<string, unknown> = {
    valid,
    scorable: scorableKeys.length,
    labeled: scorableKeys.length - unlabeled.length,
  };
  if (unlabeled.length > 0) {
    result.unlabeled = unlabeled.map((u) => ({ key: u.key, line: u.line, type: u.type, tool: u.tool }));
  }
  if (orphaned.length > 0) result.orphaned = orphaned;
  if (invalidValues.length > 0) {
    result.invalid_values = invalidValues;
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(valid ? 0 : 2);
}

/**
 * Expand context around a specific tool_use_id or stop key.
 * Shows ±(3 * depth) summarized messages around the target line.
 */
function expandContext(
  lines: Record<string, unknown>[],
  target: string,
  depth: number,
): void {
  // Find the target line
  let targetLine = -1;

  if (target.startsWith("stop:")) {
    targetLine = parseInt(target.slice(5), 10);
  } else {
    // Search for tool_use_id
    for (let i = 0; i < lines.length; i++) {
      const classification = classifyLine(lines[i], lines, i);
      if (classification.kind === "pre-tool-use") {
        for (const block of classification.blocks) {
          if (block.id === target || block.id.startsWith(target)) {
            targetLine = i;
            break;
          }
        }
      }
      if (targetLine !== -1) break;
    }
  }

  if (targetLine === -1) {
    console.error(JSON.stringify({ error: `Target "${target}" not found in transcript` }));
    process.exit(2);
  }

  const radius = 3 * depth;
  const startLine = Math.max(0, targetLine - radius);
  const endLine = Math.min(lines.length - 1, targetLine + radius);

  const context: Record<string, unknown>[] = [];
  for (let i = startLine; i <= endLine; i++) {
    const summary = summarizeLine(lines, i);
    if (summary) {
      if (i === targetLine) {
        summary.target = true;
      }
      context.push(summary);
    }
  }

  console.log(JSON.stringify({
    target,
    target_line: targetLine,
    depth,
    range: [startLine, endLine],
    context,
  }));
}

// ─── Report Formatting ─────────────────────────────────────────────────────

function formatReport(
  results: ReplayEvent[],
  transcriptPath: string,
  labelFilePath: string | undefined,
  elapsedMs: number,
  reportFilename: string = "report.json",
  truncateToLine?: number,
): void {
  const scored = results.filter((r) => r.pass !== undefined);
  const passed = scored.filter((r) => r.pass === true);
  const failed = scored.filter((r) => r.pass === false);
  const errors = results.filter((r) => r.decision === "error" || r.decision === "timeout");

  const report: Record<string, unknown> = {
    transcript: transcriptPath,
    label_file: labelFilePath ?? null,
    total_hooks_fired: results.length,
    scored: scored.length,
    passed: passed.length,
    failed: failed.length,
    errors: errors.length,
    elapsed_ms: elapsedMs,
  };

  if (truncateToLine !== undefined) {
    report.truncate_to_line = truncateToLine;
  }

  // Only include detailed entries for failures (label != hook decision)
  if (failed.length > 0) {
    report.failures = failed.map((f) => {
      const entry: Record<string, unknown> = {
        line: f.line,
        hook: f.hook,
      };
      if (f.tool) entry.tool = f.tool;
      if (f.id) entry.id = f.id;
      entry.expected = f.expected;
      entry.actual = f.decision;
      if (f.gate) entry.gate = f.gate;
      if (f.gate_expected) entry.gate_expected = f.gate_expected;
      if (f.at !== undefined) entry.at = f.at;
      if (f.reason) entry.reason = f.reason;
      return entry;
    });
  }

  if (errors.length > 0) {
    report.error_details = errors.map((e) => ({
      line: e.line,
      hook: e.hook,
      tool: e.tool,
      id: e.id,
      error: e.error,
    }));
  }

  // Add commit hash
  report.commit = getVersion();

  // Write report to file
  const tDir = transcriptDir(transcriptPath);
  const reportPath = path.join(tDir, reportFilename);
  fs.mkdirSync(tDir, { recursive: true });

  report.report_file = reportPath;

  const reportJson = JSON.stringify(report, null, 2);
  fs.writeFileSync(reportPath, reportJson + "\n");
  console.log(reportJson);

  // Prominent instruction for the AI reading this output
  console.log("");
  console.log("=".repeat(80));
  console.log("ACTION REQUIRED: You MUST inform the user that a replay report was saved.");
  console.log(`Report file: ${reportPath}`);
  console.log(`Transcript dir: ${tDir}`);
  console.log("Tell the user: \"A replay report has been saved at:");
  console.log(`  ${reportPath}`);
  console.log("You can review it anytime.\"");
  console.log("=".repeat(80));
}

// ─── Main Replay ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const config = parseArgs();

  // Background sweep of stale caches
  sweepStaleCaches();

  // 1. Read all transcript lines
  const rawLines = fs.readFileSync(config.transcript, "utf-8").split("\n").filter(Boolean);
  const lines: Record<string, unknown>[] = rawLines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return {};
    }
  });

  const scorableKeys = collectScorableKeys(lines);
  const batchMap = detectBatches(lines);

  // Scaffold mode — generate starter label file, then exit
  if (config.scaffold) {
    scaffoldLabelFile(lines, config.transcript, scorableKeys, batchMap);
    process.exit(0);
  }

  // List mode — output tool calls and stop points, then exit
  if (config.list) {
    if (config.expand) {
      expandContext(lines, config.expand, config.depth);
    } else {
      listToolCalls(lines, batchMap);
    }
    process.exit(0);
  }

  // Validate mode — check label file completeness without hooks, then exit
  if (config.validate) {
    if (!config.expect) {
      console.error("ERROR: --validate requires --expect <label-file.json>");
      process.exit(2);
    }
    validateLabelFile(config.expect, scorableKeys);
  }

  // Validate completeness before replay (only when running with expectations, not generate-labels)
  if (config.expect && !config.generateLabels && !config.filter) {
    validateExpectationCompleteness(config.expect, scorableKeys, batchMap);
  }

  // Auto build for modes that fire hooks (skip in deployed Docker volume — dist/ is pre-built)
  if (REPO_ROOT.startsWith("/mnt/docker-data/volumes/")) {
    console.error("Skipping build (deployed volume)");
  } else {
    console.error("Building project...");
    const buildResult = runCommand("just build 2>&1", REPO_ROOT);
    if (buildResult.exitCode !== 0) {
      console.error(`ERROR: 'just build' failed (exit code ${buildResult.exitCode}):\n${buildResult.output}`);
      process.exit(2);
    }
  }

  // 2. Determine cwd
  const cwd = config.cwd ?? extractCwd(lines) ?? process.cwd();

  // 3. Set environment
  process.env.CLAUDE_PROJECT_DIR = cwd;
  process.env.AGENT_FRAMEWORK_ROOT = REPO_ROOT;

  // 4. Create persistent transcript dir and cache
  const tDir = transcriptDir(config.transcript);
  fs.mkdirSync(tDir, { recursive: true });

  // Copy transcript if not present
  const transcriptCopy = path.join(tDir, "transcript.jsonl");
  if (!fs.existsSync(transcriptCopy)) {
    fs.copyFileSync(config.transcript, transcriptCopy);
  }

  // Clean previous cache (check for live process first)
  const cachePath = cacheDir(config.transcript);
  const prevPidFile = path.join(cachePath, "replay.pid");
  try {
    const pidContent = fs.readFileSync(prevPidFile, "utf-8").trim();
    const pid = parseInt(pidContent, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0);
        console.error(`ERROR: A replay is already running for this transcript (PID ${pid}).`);
        process.exit(2);
      } catch {
        // Process is dead — safe to clean
      }
    }
  } catch {
    // No previous replay.pid
  }

  if (fs.existsSync(cachePath)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
  }

  // Create fresh cache dir
  fs.mkdirSync(cachePath, { recursive: true });
  const sessionDir = cachePath;

  // 5. Write replay.pid
  const replayPidFile = path.join(sessionDir, "replay.pid");
  fs.writeFileSync(replayPidFile, String(process.pid));

  // 6. Set AGENT_FRAMEWORK_SESSION_DIR
  process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;

  // 7. Create empty temp transcript (filename must NOT start with "agent-")
  const transcriptPath = path.join(sessionDir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "");

  // 8. Generate session ID
  const sessionId = "replay-" + transcriptSlug(config.transcript);

  const env = buildEnv(sessionDir, cwd);
  const results: ReplayEvent[] = [];
  const toolUseMap = new Map<string, { name: string; input: unknown }>();

  // 9. Fire session-start hook
  const sessionStartTime = Date.now();
  try {
    const sessionStartInput = JSON.stringify({
      hook_event_name: "SessionStart",
      source: "startup",
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
    });

    const sessionStartResult = await runHook({
      hookScript: hookScript("session-start"),
      inputJson: sessionStartInput,
      env,
      timeoutMs: config.timeout,
    });

    results.push({
      line: 0,
      hook: "session-start",
      decision: sessionStartResult.exitCode === 0 ? "ok" : "error",
      ms: Date.now() - sessionStartTime,
      ...(sessionStartResult.exitCode !== 0 && {
        error: sessionStartResult.stderr.slice(0, 500),
      }),
    });
  } catch (err) {
    results.push({
      line: 0,
      hook: "session-start",
      decision: "error",
      ms: Date.now() - sessionStartTime,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Truncation cap (1-based). When set, only transcript entries whose
  // 1-based line index <= config.truncateToLine are appended to the
  // on-disk temp transcript. Hooks still fire for tool_use entries whose
  // line is beyond the cap because the hook input is synthesized from the
  // in-memory parsed lines, not read from the temp file.
  const appendAllowed = (lineIndex: number): boolean =>
    config.truncateToLine === undefined || (lineIndex + 1) <= config.truncateToLine;

  // 10. Walk transcript lines
  for (let i = 0; i < lines.length; i++) {
    const parsed = lines[i];
    const rawLine = rawLines[i];

    // Append line to temp transcript (subject to truncation cap).
    if (appendAllowed(i)) {
      fs.appendFileSync(transcriptPath, rawLine + "\n");
    }

    // Classify the line
    const classification = classifyLine(parsed, lines, i);

    if (classification.kind === "skip") {
      continue;
    }

    if (classification.kind === "user-prompt-submit") {
      const hookStart = Date.now();
      try {
        const input = JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: classification.prompt,
          transcript_path: transcriptPath,
          session_id: sessionId,
          cwd,
        });

        const hookResult = await runHook({
          hookScript: hookScript("user-prompt-submit"),
          inputJson: input,
          env,
          timeoutMs: config.timeout,
        });

        results.push({
          line: i,
          hook: "user-prompt-submit",
          decision: hookResult.exitCode === 0 ? "ok" : "error",
          ms: Date.now() - hookStart,
          ...(hookResult.exitCode !== 0 && {
            error: hookResult.stderr.slice(0, 500),
          }),
        });
      } catch (err) {
        results.push({
          line: i,
          hook: "user-prompt-submit",
          decision: "error",
          ms: Date.now() - hookStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }

    if (classification.kind === "pre-tool-use") {
      // Look ahead: append all consecutive assistant-tool_use lines
      // (and intervening skip lines) BEFORE firing any hooks, subject to
      // the truncation cap. The look-ahead itself still walks so that
      // `j` advances past the whole batch — we just skip the physical
      // append when truncation blocks it.
      let j = i + 1;
      while (j < lines.length) {
        const nextClassification = classifyLine(lines[j], lines, j);
        if (nextClassification.kind === "skip" || nextClassification.kind === "pre-tool-use") {
          if (appendAllowed(j)) {
            fs.appendFileSync(transcriptPath, rawLines[j] + "\n");
          }
          j++;
          continue;
        }
        break;
      }

      // Now fire hooks for all pre-tool-use lines in [i, j)
      for (let k = i; k < j; k++) {
        const kClassification = classifyLine(lines[k], lines, k);
        if (kClassification.kind !== "pre-tool-use") continue;

        for (const block of kClassification.blocks) {
          // Register in toolUseMap
          toolUseMap.set(block.id, { name: block.name, input: block.input });

          // If --filter is active, skip hooks that don't match the target key
          if (config.filter && !block.id.startsWith(config.filter) && config.filter !== block.id) {
            continue;
          }

          const hookStart = Date.now();
          try {
            const input = JSON.stringify({
              hook_event_name: "PreToolUse",
              session_id: sessionId,
              transcript_path: transcriptPath,
              cwd,
              tool_name: block.name,
              tool_input: block.input,
              tool_use_id: block.id,
            });

            const hookResult = await runHook({
              hookScript: hookScript("pre-tool-use"),
              inputJson: input,
              env,
              timeoutMs: config.timeout,
            });

            // Parse decision
            const parsed = parsePreToolUseDecision(hookResult, config.timeout);
            const decision = parsed.decision;
            const parseError = parsed.error;

            // Read tool-log for diagnostics
            const { gate, reason } = readLastToolLogEntry(sessionDir);

            // Capture live prediction snapshot BEFORE any subsequent event
            // mutates the cache. Only relevant for prediction-block deny
            // chains (or batch-siblings whose leader was prediction-block).
            let livePrediction: LivePredictionSnapshot | undefined;
            if (decision === "deny" && (gate === "prediction-block" || gate === "batch-sibling")) {
              const toolLog = readToolLogEntries(sessionDir, 200);
              const lastEntry = toolLog.length > 0 ? toolLog[toolLog.length - 1] : undefined;
              const isPredictionChain =
                gate === "prediction-block" ||
                (gate === "batch-sibling" &&
                  lastEntry !== undefined &&
                  getBatchLeaderGate(toolLog, lastEntry) === "prediction-block");
              if (isPredictionChain) {
                let matchTarget: { toolName: string; toolInput: unknown } | null = null;
                if (gate === "batch-sibling" && lastEntry !== undefined) {
                  matchTarget = getBatchLeaderToolInfo(toolLog, lastEntry, toolUseMap);
                } else {
                  matchTarget = { toolName: block.name, toolInput: block.input };
                }
                if (matchTarget) {
                  const live = await findActivePredictionMatching(
                    sessionDir,
                    matchTarget.toolName,
                    matchTarget.toolInput,
                  );
                  if (live) {
                    livePrediction = {
                      mood: live.prediction.mood,
                      trust: live.prediction.trust,
                      intent: live.prediction.intent,
                      blockedIntent: live.prediction.blockedIntent,
                      explicitlyAllowedTools: [...live.prediction.explicitlyAllowedTools],
                      explicitlyBlockedSubstrings: live.prediction.explicitlyBlockedSubstrings.map((b) => ({
                        tool: b.tool,
                        targetSubstring: b.targetSubstring,
                        reason: b.reason,
                      })),
                      ...(live.decision.matchedExplicit
                        ? {
                            matchedExplicit: {
                              tool: live.decision.matchedExplicit.tool,
                              targetSubstring: live.decision.matchedExplicit.targetSubstring,
                              reason: live.decision.matchedExplicit.reason,
                            },
                          }
                        : {}),
                    };
                  }
                }
              }
            }

            // Match against expectations, filtered to the run's truncation slice.
            const matched = matchExpectation(config.expect, block.id);
            const scopedMatches = scopedExpectations(matched, config.truncateToLine);

            const baseEvent: ReplayEvent = {
              line: k,
              hook: "pre-tool-use",
              tool: block.name,
              id: block.id.slice(0, 16),
              decision,
              ms: Date.now() - hookStart,
            };

            if (gate) baseEvent.gate = gate;
            if (reason) baseEvent.reason = reason;
            if (config.truncateToLine !== undefined) {
              baseEvent.at = config.truncateToLine;
            }
            if (livePrediction) baseEvent.livePrediction = livePrediction;

            if (parseError) baseEvent.error = parseError;

            if (scopedMatches.length === 0) {
              // No scoring entry for this run's truncation slice.
              results.push(baseEvent);
            } else {
              for (const exp of scopedMatches) {
                const event: ReplayEvent = { ...baseEvent };
                event.expected = exp.expected;
                event.at = exp.at ?? "full";
                if (exp.by) {
                  event.gate_expected = exp.by;
                }
                const scored = scoreRichExpectation(decision, gate, exp, {
                  sessionDir,
                  toolName: block.name,
                  toolInput: block.input,
                });
                event.pass = scored.pass;
                if (scored.reason) {
                  event.reason = scored.reason;
                }
                results.push(event);
              }
            }
          } catch (err) {
            results.push({
              line: k,
              hook: "pre-tool-use",
              tool: block.name,
              id: block.id.slice(0, 16),
              decision: "error",
              ms: Date.now() - hookStart,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // j points to the first non-batch line. Set i = j - 1 because the
      // for loop's i++ will advance to j, processing that line normally.
      i = j - 1;
      continue;
    }

    if (classification.kind === "post-tool-use") {
      for (const result of classification.results) {
        const toolInfo = toolUseMap.get(result.tool_use_id);
        const toolName = toolInfo?.name ?? "unknown";
        const toolInput = toolInfo?.input ?? {};

        // Stringify tool_response if it's an array
        let toolResponse: string;
        if (typeof result.content === "string") {
          toolResponse = result.content;
        } else if (Array.isArray(result.content)) {
          toolResponse = JSON.stringify(result.content);
        } else {
          toolResponse = String(result.content ?? "");
        }

        const hookStart = Date.now();
        try {
          const input = JSON.stringify({
            hook_event_name: "PostToolUse",
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd,
            tool_name: toolName,
            tool_input: toolInput,
            tool_use_id: result.tool_use_id,
            tool_response: toolResponse,
          });

          const hookResult = await runHook({
            hookScript: hookScript("post-tool-use"),
            inputJson: input,
            env,
            timeoutMs: config.timeout,
          });

          results.push({
            line: i,
            hook: "post-tool-use",
            tool: toolName,
            id: result.tool_use_id.slice(0, 16),
            decision: hookResult.exitCode === 0 ? "ok" : "error",
            ms: Date.now() - hookStart,
            ...(hookResult.exitCode !== 0 && {
              error: hookResult.stderr.slice(0, 500),
            }),
          });
        } catch (err) {
          results.push({
            line: i,
            hook: "post-tool-use",
            tool: toolName,
            id: result.tool_use_id.slice(0, 16),
            decision: "error",
            ms: Date.now() - hookStart,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      continue;
    }

    if (classification.kind === "stop-response-check") {
      const stopKey = `stop:${i}`;
      if (config.filter && config.filter !== stopKey) {
        continue;
      }
      const hookStart = Date.now();
      try {
        const input = JSON.stringify({
          hook_event_name: "Stop",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          stop_hook_active: true,
        });

        const hookResult = await runHook({
          hookScript: hookScript("stop-response-check"),
          inputJson: input,
          env,
          timeoutMs: config.timeout,
        });

        // Parse decision
        const stopParsed = parseStopDecision(hookResult, config.timeout);
        const decision = stopParsed.decision;
        const reason = stopParsed.reason;

        // Match against expectations (rich-form aware)
        const stopMatched = matchExpectation(config.expect, stopKey);
        const stopScoped = scopedExpectations(stopMatched, config.truncateToLine);

        const baseStopEvent: ReplayEvent = {
          line: i,
          hook: "stop-response-check",
          decision,
          ms: Date.now() - hookStart,
        };

        if (reason) baseStopEvent.reason = reason;
        if (config.truncateToLine !== undefined) {
          baseStopEvent.at = config.truncateToLine;
        }
        if (stopParsed.error) {
          baseStopEvent.error = stopParsed.error;
        }

        if (stopScoped.length === 0) {
          results.push(baseStopEvent);
        } else {
          for (const exp of stopScoped) {
            const event: ReplayEvent = { ...baseStopEvent };
            event.expected = exp.expected;
            event.at = exp.at ?? "full";
            const scored = scoreRichExpectation(decision, undefined, exp);
            event.pass = scored.pass;
            if (scored.reason) event.reason = scored.reason;
            results.push(event);
          }
        }
      } catch (err) {
        results.push({
          line: i,
          hook: "stop-response-check",
          decision: "error",
          ms: Date.now() - hookStart,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
  }

  if (config.filter && results.filter(r => r.hook === "pre-tool-use" || r.hook === "stop-response-check").length === 0) {
    console.error(`WARNING: --filter "${config.filter}" matched no hooks in the transcript.`);
  }

  // 11. Generate-labels mode — write labels.draft.json and exit
  if (config.generateLabels) {
    const labels: Record<string, LabelValue> = {};
    const reasoning: Record<string, string> = {};
    let investigateCount = 0;

    for (const event of results) {
      if (event.hook === "pre-tool-use") {
        const toolUseId = findFullToolUseId(event, scorableKeys);
        if (event.decision === "error" || event.decision === "timeout") {
          labels[toolUseId] = "INVESTIGATE";
          reasoning[toolUseId] = event.error ?? "Hook error or timeout";
          investigateCount++;
        } else if (event.decision === "deny" && event.livePrediction) {
          // Rich-form label with auto-populated prediction annotation.
          // Reviewer flips verdict to too_broad/wrong per hindsight.
          const intent = event.livePrediction.intent.trim();
          const intentExcerpt = intent ? intent.slice(0, 60) : undefined;
          const richLabel: RichExpectation = {
            expected: "deny",
            by: event.gate ?? "prediction-block",
            prediction: {
              verdict: "correct",
              ...(intentExcerpt ? { intent_must_contain: intentExcerpt } : {}),
              expected_mood: event.livePrediction.mood,
              notes: intentExcerpt
                ? "[auto] live intent excerpt + mood; verify hindsight"
                : "[auto] live prediction matched but intent was empty; verify hindsight",
            },
          };
          labels[toolUseId] = richLabel;
          const parts: string[] = [];
          if (event.gate) parts.push(`gate: ${event.gate}`);
          if (event.reason) parts.push(event.reason);
          reasoning[toolUseId] = parts.length > 0
            ? `${parts.join(" - ")} [prediction-annotation auto-set verdict=correct]`
            : "Hook decision recorded [prediction-annotation auto-set verdict=correct]";
        } else {
          labels[toolUseId] = event.decision === "allow" ? "allow" : "deny";
          const parts: string[] = [];
          if (event.gate) parts.push(`gate: ${event.gate}`);
          if (event.reason) parts.push(event.reason);
          reasoning[toolUseId] = parts.length > 0 ? parts.join(" - ") : "Hook decision recorded";
        }
      } else if (event.hook === "stop-response-check") {
        const stopKey = `stop:${event.line}`;
        if (event.decision === "error" || event.decision === "timeout") {
          labels[stopKey] = "INVESTIGATE";
          reasoning[stopKey] = event.error ?? "Hook error or timeout";
          investigateCount++;
        } else {
          labels[stopKey] = event.decision === "block" ? "block" : "pass";
          reasoning[stopKey] = event.reason ?? "Hook decision recorded";
        }
      }
    }

    const draftPath = path.join(tDir, "labels.draft.json");
    const draftOutput = {
      _meta: {
        transcript: config.transcript,
        created: new Date().toISOString(),
        commit: getVersion(),
        status: "in_progress",
        total_hooks: Object.keys(labels).length,
        investigate_count: investigateCount,
      },
      labels,
      reasoning,
    };

    fs.writeFileSync(draftPath, JSON.stringify(draftOutput, null, 2) + "\n");

    try {
      fs.unlinkSync(replayPidFile);
    } catch {
      // Best-effort
    }

    console.log(draftPath);
    process.exit(0);
  }

  // 12. Output structured report
  const elapsedMs = Date.now() - startTime;
  const reportFilename = config.filter ? "report-single.json" : "report.json";
  formatReport(
    results,
    config.transcript,
    config.expectPath,
    elapsedMs,
    reportFilename,
    config.truncateToLine,
  );

  // 13. Compute exit code
  const failed = results.filter((r) => r.pass === false);

  // 14. Cleanup
  // Remove replay.pid
  try {
    fs.unlinkSync(replayPidFile);
  } catch {
    // Best-effort
  }

  // Exit with appropriate code
  if (failed.length > 0) {
    process.exit(1);
  }

  process.exit(0);
}

/**
 * Find the full tool_use_id for a replay event by matching its truncated id
 * against the scorable keys list.
 */
function findFullToolUseId(
  event: ReplayEvent,
  scorableKeys: Array<{ key: string; line: number; type: "tool_use" | "stop"; tool?: string }>,
): string {
  if (!event.id) return `unknown:${event.line}`;
  // The event.id is truncated to 16 chars — find the full key
  const match = scorableKeys.find(
    (sk) => sk.type === "tool_use" && sk.key.startsWith(event.id!)
  );
  return match?.key ?? event.id;
}

main().catch((err) => {
  console.error("Fatal error:", err instanceof Error ? err.message : String(err));
  process.exit(2);
});
