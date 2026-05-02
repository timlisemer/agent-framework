#!/usr/bin/env npx tsx
/**
 * Scenario runner — fire a single hook against a hand-authored synthetic
 * transcript state. Unlike replay.ts which walks a real session JSONL,
 * scenario.ts materializes a tiny on-disk transcript from a Scenario blob,
 * fires exactly one hook through the same runHook path, and scores the
 * result against a RichExpectation.
 *
 * Usage:
 *   npx tsx test-harness/scenario.ts --scenario <absolute-path-to-scenario.json>
 *
 * Exit codes: 0 = pass, 1 = fail, 2 = validation/invocation error
 *
 * @module test-harness/scenario
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { scenarioLastRunFile, scenarioPlansDir, scenarioRunDir } from "../utils/paths.js";
import {
  type FanoutFireResult,
  type HookEventName,
  type Scenario,
  type ScenarioBlock,
  type ScenarioResult,
  validateScenario,
} from "./lib/replay-types.js";
import type {
  PredictionAssertionResult,
  ReasonMustExpectation,
  ReasonMustResult,
  ScenarioPredictionExpectation,
} from "./types.js";
import { runHook } from "./lib/harness.js";
import {
  buildEnv,
  explicitlyBlockedContainsForbidden,
  getVersion,
  hookScript,
  parseExitCodeDecision,
  parsePreToolUseDecision,
  parseStopDecision,
  readToolLogEntriesAfterOffset,
  scoreRichExpectation,
} from "./lib/hook-runner.js";
import { sessionStateDefaults, type SessionState } from "../utils/session-store.js";
import type { ToolPrediction } from "../utils/prediction-types.js";
import { scenarioDir } from "../agents/mcp/scenario-mcp-shared.js";
import type { ScenarioSourceTag } from "../agents/mcp/scenario-mcp-shared.js";

function getArg(name: string, required: boolean = false): string | undefined {
  const args = process.argv.slice(2);
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

function hookScriptName(event: HookEventName): string {
  const map: Record<HookEventName, string> = {
    PreToolUse: "pre-tool-use",
    PostToolUse: "post-tool-use",
    Stop: "stop-response-check",
    UserPromptSubmit: "user-prompt-submit",
    SessionStart: "session-start",
    PostToolUseFailure: "post-tool-use-failure",
    SubagentStart: "subagent-start",
    SubagentStop: "subagent-stop",
  };
  return map[event];
}

interface MaterializeCtx {
  transcriptPath: string;
  sessionId: string;
  cwd: string;
}

/**
 * One resolved tool_use block present in the final assistant entry.
 */
interface FinalToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * A materialized sub-line of the final assistant_split entry. Indexed by
 * sub-line position 0..entry.lines.length-1 (NOT only tool_use positions),
 * so fan-out callers can grow the on-disk file uniformly for any position.
 * `absoluteIndex` is the sub-line's index in `allLines`. `toolUse` is
 * populated only when the sub-line carries a tool_use block.
 */
interface FinalSplitSubLineInfo {
  subLineIndex: number;
  absoluteIndex: number;
  toolUse?: FinalToolUse;
}

interface BuildResult {
  allLines: string[];
  /**
   * Index into `allLines` where the first sub-line of the final
   * assistant_split entry begins. For non-`assistant_split` final entries
   * this equals `allLines.length` (no final split sub-lines).
   */
  finalSplitStart: number;
  /**
   * One entry per sub-line of the final `assistant_split` entry (empty
   * when the final entry is not a split). In single-hook mode with
   * `batch_visible_through` set, `allLines` only contains sub-lines
   * [0..cap]; entries past `cap` in this array point to absoluteIndex
   * values that are NOT in `allLines`. Single-hook mode must not index
   * past the cap.
   */
  finalSplitSubLines: FinalSplitSubLineInfo[];
  finalToolUses: FinalToolUse[];
}

/**
 * Build every jsonl line for the scenario (in-memory only — does NOT
 * write to disk). Used by both single-hook and fan-out paths so that
 * `materializeBlocks` id synthesis is stable across the two modes.
 *
 * In single-hook mode, honors `target.batch_visible_through` by capping
 * which sub-lines of the final `assistant_split` are included in
 * `allLines`. In fan-out mode, `allLines` contains every sub-line and
 * the fan-out runner writes progressively growing slices via
 * `writeTranscriptSlice`.
 */
function buildAllTranscriptLines(
  scenario: Scenario,
  ctx: MaterializeCtx,
): BuildResult {
  const permissionMode = scenario.env?.permission_mode ?? "default";
  const allLines: string[] = [];
  let prevUuid: string | null = null;
  const baseTs = Date.now();
  let toolUseCounter = 0;
  const finalToolUses: FinalToolUse[] = [];
  const finalSplitSubLines: FinalSplitSubLineInfo[] = [];
  const finalIndex = scenario.transcript.length - 1;
  let finalSplitStart = -1;

  const nextToolUseId = () => {
    toolUseCounter += 1;
    return `toolu_scenario_${toolUseCounter}`;
  };

  const emitAssistantLine = (
    blocks: ScenarioBlock[],
    msgId: string,
    entryIndex: number,
    lineOffset: number,
  ): void => {
    materializeBlocks(blocks, nextToolUseId);
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const uuid = crypto.randomUUID();
    const timestamp = new Date(
      baseTs + entryIndex * 100 + lineOffset * 10,
    ).toISOString();
    const message: Record<string, unknown> = {
      id: msgId,
      model: "claude-opus-4-6",
      role: "assistant",
      content: blocks,
      stop_reason: hasToolUse ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const line: Record<string, unknown> = {
      parentUuid: prevUuid,
      isSidechain: false,
      userType: "external",
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      version: "0.0.0",
      type: "assistant",
      message,
      uuid,
      timestamp,
      permissionMode,
    };
    prevUuid = uuid;
    allLines.push(JSON.stringify(line));
  };

  const fanout = scenario.target.fanout === true;

  for (let i = 0; i < scenario.transcript.length; i++) {
    const entry = scenario.transcript[i];
    const isFinal = i === finalIndex;
    if (entry.role === "user") {
      const content =
        typeof entry.content === "string"
          ? entry.content
          : materializeBlocks(entry.content, nextToolUseId);
      const uuid = crypto.randomUUID();
      const timestamp = new Date(baseTs + i * 100).toISOString();
      const line: Record<string, unknown> = {
        parentUuid: prevUuid,
        isSidechain: false,
        userType: "external",
        cwd: ctx.cwd,
        sessionId: ctx.sessionId,
        version: "0.0.0",
        type: "user",
        message: { role: "user", content },
        uuid,
        timestamp,
        permissionMode,
      };
      if (entry.isMeta === true) line.isMeta = true;
      prevUuid = uuid;
      allLines.push(JSON.stringify(line));
    } else if (entry.role === "assistant") {
      emitAssistantLine(entry.content, `msg_scenario_${i}`, i, 0);
      if (isFinal) {
        for (const b of entry.content) {
          if (b.type === "tool_use") {
            finalToolUses.push({
              id: (b as { id: string }).id,
              name: b.name,
              input: b.input,
            });
          }
        }
      }
    } else {
      // assistant_split
      if (isFinal) {
        finalSplitStart = allLines.length;
      }
      const lastIdx = entry.lines.length - 1;
      // In single-hook mode, honor batch_visible_through by clipping the
      // slice written into `allLines`. In fan-out mode, every sub-line
      // is materialized and the fan-out runner grows the on-disk file
      // slice-by-slice. See TranscriptEntry / AssistantGroup in
      // src/utils/transcript.ts for the on-disk shape this must match.
      const cap =
        !fanout && isFinal && scenario.target.batch_visible_through !== undefined
          ? scenario.target.batch_visible_through
          : lastIdx;
      // Fan-out: iterate all sub-lines. Single-hook: stop at cap.
      const upperBound = fanout && isFinal ? lastIdx : cap;
      for (let j = 0; j <= upperBound; j++) {
        const absoluteIndex = allLines.length;
        // emitAssistantLine runs materializeBlocks internally, so by the
        // time it returns the block id fields are synthesized and we can
        // record the resolved tool_use for finalSplitSubLines /
        // finalToolUses.
        emitAssistantLine(entry.lines[j].blocks, entry.msg_id, i, j);
        if (isFinal) {
          let resolved: FinalToolUse | undefined;
          for (const b of entry.lines[j].blocks) {
            if (b.type === "tool_use") {
              resolved = {
                id: (b as { id: string }).id,
                name: b.name,
                input: b.input,
              };
              break;
            }
          }
          finalSplitSubLines.push({
            subLineIndex: j,
            absoluteIndex,
            toolUse: resolved,
          });
          // In single-hook mode the visible slice is what finalToolUses
          // must reflect (the collector previously ran only inside
          // emitAssistantLine calls that actually executed — that
          // transitive shortening is preserved here).
          if (!fanout && resolved && j <= cap) {
            finalToolUses.push(resolved);
          }
        }
      }
    }
  }

  if (finalSplitStart === -1) {
    finalSplitStart = allLines.length;
  }

  // When seed_state.planFile is set, stamp `slug` onto the first synthesized
  // JSONL line so extractSlugFromSession (src/utils/session-utils.ts:30) finds
  // it. The function reads `entry.slug` from any line, returning the first
  // hit — picking the first line keeps the placement uniform regardless of
  // which role it carries.
  if (scenario.seed_state?.planFile && allLines.length > 0) {
    const first = JSON.parse(allLines[0]) as Record<string, unknown>;
    first.slug = scenario.seed_state.planFile.slug;
    allLines[0] = JSON.stringify(first);
  }

  return { allLines, finalSplitStart, finalSplitSubLines, finalToolUses };
}

/**
 * Write `allLines.slice(0, upToExclusive)` to `transcriptPath`. Used by
 * both single-hook (called once) and fan-out (called once per fire, with
 * a monotonically growing upper bound). Rewrite semantics (not append)
 * are safe because every transcript reader re-reads the full file each
 * call with no inode/mtime caching. The harness awaits each `runHook`
 * before writing the next slice, so no concurrent read can observe a
 * torn write.
 */
function writeTranscriptSlice(
  transcriptPath: string,
  allLines: string[],
  upToExclusive: number,
): void {
  const slice = allLines.slice(0, upToExclusive);
  fs.writeFileSync(transcriptPath, slice.join("\n") + (slice.length > 0 ? "\n" : ""));
}

/**
 * Walk the scenario blocks and assign synthesized ids to any tool_use
 * block that doesn't carry one. Mutates the block objects in place so
 * callers see the resolved ids.
 */
function materializeBlocks(
  blocks: ScenarioBlock[],
  nextId: () => string,
): ScenarioBlock[] {
  for (const b of blocks) {
    if (b.type === "tool_use" && !b.id) {
      (b as { id: string }).id = nextId();
    }
  }
  return blocks;
}

function resolveToolUseBlock(
  scenario: Scenario,
  finalToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
): { id: string; name: string; input: Record<string, unknown> } {
  const ref = scenario.target.tool_use_ref ?? "last";
  if (ref === "last") {
    // Defensive: the validator rejects tool_use_ref="last" (and omission,
    // which defaults to "last") whenever batch_visible_through is set,
    // because "last" is ambiguous under truncation. This branch must
    // therefore never run under a cap. Assert the contract explicitly.
    if (scenario.target.batch_visible_through !== undefined) {
      throw new Error(
        'internal: tool_use_ref="last" combined with batch_visible_through should have been rejected by validateScenario',
      );
    }
    if (finalToolUses.length === 0) {
      throw new Error(
        "target.tool_use_ref='last' but the final assistant entry has no tool_use blocks",
      );
    }
    return finalToolUses[finalToolUses.length - 1];
  }
  const found = finalToolUses.find((b) => b.id === ref);
  if (!found) {
    throw new Error(
      `target.tool_use_ref "${ref}" does not match any tool_use in the final assistant entry`,
    );
  }
  return found;
}

interface BuildInputCtx {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  finalToolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

function buildHookInput(scenario: Scenario, ctx: BuildInputCtx): Record<string, unknown> {
  const base: Record<string, unknown> = {
    hook_event_name: scenario.target.hook,
    session_id: ctx.sessionId,
    transcript_path: ctx.transcriptPath,
    cwd: ctx.cwd,
    permission_mode: scenario.env?.permission_mode ?? "default",
  };

  switch (scenario.target.hook) {
    case "PreToolUse": {
      const block = resolveToolUseBlock(scenario, ctx.finalToolUses);
      return {
        ...base,
        tool_name: block.name,
        tool_input: block.input,
        tool_use_id: block.id,
      };
    }
    case "PostToolUse": {
      const block = resolveToolUseBlock(scenario, ctx.finalToolUses);
      // Synthesize a minimal tool_response. For scoring purposes the
      // content doesn't matter — rules that care should express it via
      // scenario transcript tool_result blocks and a later assertion.
      return {
        ...base,
        tool_name: block.name,
        tool_input: block.input,
        tool_use_id: block.id,
        tool_response: "",
      };
    }
    case "Stop":
      return {
        ...base,
        stop_hook_active: true,
      };
    case "UserPromptSubmit": {
      const lastUser = scenario.transcript[scenario.transcript.length - 1];
      const lastUserContent = "content" in lastUser ? lastUser.content : "";
      const prompt =
        scenario.target.prompt_override ??
        (typeof lastUserContent === "string" ? lastUserContent : "");
      return {
        ...base,
        prompt,
      };
    }
    case "SessionStart":
      return {
        ...base,
        source: "startup",
      };
    case "PostToolUseFailure":
      return {
        ...base,
        tool_name: "",
        error: "",
        is_interrupt: false,
      };
    case "SubagentStart":
      return {
        ...base,
        agent_id: "scenario-agent",
        agent_type: "scenario",
      };
    case "SubagentStop":
      return {
        ...base,
        agent_id: "scenario-agent",
        agent_transcript_path: ctx.transcriptPath,
        stop_hook_active: false,
      };
  }
}

function parseDecisionForHook(
  hook: HookEventName,
  hookResult: Parameters<typeof parsePreToolUseDecision>[0],
  timeoutMs: number,
): { decision: string; reason?: string; error?: string } {
  switch (hook) {
    case "PreToolUse":
      return parsePreToolUseDecision(hookResult, timeoutMs);
    case "Stop":
      return parseStopDecision(hookResult, timeoutMs);
    case "PostToolUse":
    case "UserPromptSubmit":
    case "SessionStart":
    case "PostToolUseFailure":
    case "SubagentStart":
    case "SubagentStop":
      return parseExitCodeDecision(hookResult, timeoutMs);
  }
}

/**
 * Read the live `currentPrediction` from `state.json`. Returns null when
 * the file is missing, corrupt, or carries no prediction.
 */
function readLivePrediction(cacheDir: string): ToolPrediction | null {
  const statePath = path.join(cacheDir, "state.json");
  try {
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as { data?: { currentPrediction?: ToolPrediction | null } };
    return parsed.data?.currentPrediction ?? null;
  } catch {
    return null;
  }
}

/**
 * Evaluate the optional `scenario.predictions` block against the live
 * `state.json` `currentPrediction`. Returns one PredictionAssertionResult
 * per assertion. Caller is responsible for draining background updaters
 * BEFORE invoking this so the read sees a consistent state.
 */
async function evaluateScenarioPredictions(
  cacheDir: string,
  spec: ScenarioPredictionExpectation,
): Promise<PredictionAssertionResult[]> {
  const live = readLivePrediction(cacheDir);
  const results: PredictionAssertionResult[] = [];
  if (spec.must_be_empty === true) {
    results.push({
      kind: "must_be_empty",
      pass: live === null,
      reason:
        live === null ? undefined : `expected no active prediction, found one (mood=${live.mood})`,
    });
    return results;
  }
  if (spec.must_block) {
    for (const filter of spec.must_block) {
      const matched =
        live !== null &&
        explicitlyBlockedContainsForbidden(live.explicitlyBlockedSubstrings, {
          tool: filter.tool,
          target_pattern: filter.target_substring,
        });
      results.push({
        kind: "must_block",
        filter,
        pass: matched,
        reason: matched
          ? undefined
          : `must_block: no explicitlyBlockedSubstrings entry matches tool=${filter.tool}${filter.target_substring ? `, target_substring=${filter.target_substring}` : ""}`,
      });
    }
  }
  if (spec.must_not_block) {
    for (const filter of spec.must_not_block) {
      const matched =
        live !== null &&
        explicitlyBlockedContainsForbidden(live.explicitlyBlockedSubstrings, {
          tool: filter.tool,
          target_pattern: filter.target_substring,
        });
      results.push({
        kind: "must_not_block",
        filter,
        pass: !matched,
        reason: matched
          ? `must_not_block: an explicitlyBlockedSubstrings entry matches tool=${filter.tool}${filter.target_substring ? `, target_substring=${filter.target_substring}` : ""}`
          : undefined,
      });
    }
  }
  if (spec.must_have_mood !== undefined) {
    const ok = live !== null && live.mood === spec.must_have_mood;
    results.push({
      kind: "must_have_mood",
      pass: ok,
      reason: ok
        ? undefined
        : `must_have_mood: expected ${spec.must_have_mood}, got ${live ? live.mood : "(none)"}`,
    });
  }
  if (spec.must_have_trust !== undefined) {
    const ok = live !== null && live.trust === spec.must_have_trust;
    results.push({
      kind: "must_have_trust",
      pass: ok,
      reason: ok
        ? undefined
        : `must_have_trust: expected ${spec.must_have_trust}, got ${live ? live.trust : "(none)"}`,
    });
  }
  if (spec.must_not_have_mood !== undefined) {
    const forbidden = spec.must_not_have_mood;
    const ok = live !== null && !forbidden.includes(live.mood);
    results.push({
      kind: "must_not_have_mood",
      pass: ok,
      reason: ok
        ? undefined
        : `must_not_have_mood: mood ${live ? live.mood : "(none)"} is forbidden (forbidden: [${forbidden.join(", ")}])`,
    });
  }
  if (spec.must_not_have_trust !== undefined) {
    const forbidden = spec.must_not_have_trust;
    const ok = live !== null && !forbidden.includes(live.trust);
    results.push({
      kind: "must_not_have_trust",
      pass: ok,
      reason: ok
        ? undefined
        : `must_not_have_trust: trust ${live ? live.trust : "(none)"} is forbidden (forbidden: [${forbidden.join(", ")}])`,
    });
  }
  if (spec.intent_must_contain !== undefined) {
    const ok = live !== null && live.intent.includes(spec.intent_must_contain);
    results.push({
      kind: "intent_must_contain",
      pass: ok,
      reason: ok
        ? undefined
        : `intent_must_contain: live intent ${live ? `"${live.intent}"` : "(none)"} does not contain "${spec.intent_must_contain}"`,
    });
  }
  return results;
}

/**
 * Write per-run reality to a last-run.json sidecar under the scenario's
 * home-tree run dir. This keeps the committed fixture file immutable.
 * Best-effort: transient failures must NOT fail the run — log a warning
 * to stderr and continue.
 */
function writeLastRun(
  name: string,
  scenarioPath: string,
  expectation_reality: "expected-to-pass" | "fixture-bug" | "expected-to-fail" | null,
  expectation_reality_last_run_at: string,
): void {
  try {
    const lastRunPath = scenarioLastRunFile(name);
    const dir = path.dirname(lastRunPath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      reality: expectation_reality,
      at: expectation_reality_last_run_at,
      source_path: scenarioPath,
      report_path: path.join(dir, "report-scenario.json"),
    };
    fs.writeFileSync(lastRunPath, JSON.stringify(payload, null, 2) + "\n");
  } catch (err) {
    console.error(
      `warning: failed to write last-run.json for scenario ${name}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
}

/**
 * Compute the expectation_reality value for a run.
 * - pass === true -> "expected-to-pass"
 * - pass === false + source "expected-to-fail" -> "expected-to-fail"
 * - pass === false + source "fixture-bug" -> "fixture-bug"
 * - pass === false + source "home" or unset -> null (no folder context)
 * - pass === false + source "expected-to-pass" -> "fixture-bug" (regression)
 */
function computeExpectationReality(
  pass: boolean,
  source: ScenarioSourceTag | undefined,
): "expected-to-pass" | "fixture-bug" | "expected-to-fail" | null {
  if (pass) return "expected-to-pass";
  if (source === "expected-to-fail") return "expected-to-fail";
  if (source === "fixture-bug") return "fixture-bug";
  if (source === "home" || source === undefined) return null;
  // source === "expected-to-pass" with pass===false is a regression
  return "fixture-bug";
}

async function main() {
  const scenarioPath = getArg("scenario", true)!;
  // --source is required: "home" | "expected-to-pass" | "fixture-bug" | "expected-to-fail"
  const sourceArg = getArg("source", false) as ScenarioSourceTag | undefined;
  if (!fs.existsSync(scenarioPath)) {
    console.error(`scenario file not found: ${scenarioPath}`);
    process.exit(2);
  }

  let scenario: Scenario;
  try {
    scenario = validateScenario(JSON.parse(fs.readFileSync(scenarioPath, "utf-8")));
  } catch (err) {
    console.error(
      "scenario validation failed: " +
        (err instanceof Error ? err.message : String(err)),
    );
    process.exit(2);
  }

  const started = Date.now();
  // outputDir always lives under the home tree so fixture files are never
  // polluted by per-run artifacts.
  const outputDir = scenarioRunDir(scenario.name);
  fs.mkdirSync(outputDir, { recursive: true });
  const cacheDir = path.join(scenarioDir(scenario.name), "cache");
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  // Deterministic "no subagents active" state for checkCounterFallback. When
  // env.subagent === true the filename short-circuit fires first and this
  // file is ignored; when false the counter fallback reads this and returns
  // {count:0, isSubagent:false}.
  fs.writeFileSync(
    path.join(cacheDir, "active-subagents.json"),
    JSON.stringify({ agents: [] }),
  );

  // Seed state.json from scenario.seed_state BEFORE session-start fires so the
  // hook pipeline observes the prior-turn session state. Validation guarantees
  // every required field is present; only currentPrediction.timestamp is
  // optional (filled here with Date.now() so scenarios don't hand-pick it).
  {
    const seedPrediction = scenario.seed_state.currentPrediction;
    const seeded: SessionState = {
      ...sessionStateDefaults(),
      currentPrediction: {
        mood: seedPrediction.mood,
        trust: seedPrediction.trust,
        intent: seedPrediction.intent,
        blockedIntent: seedPrediction.blockedIntent,
        explicitlyAllowedTools: seedPrediction.explicitlyAllowedTools,
        explicitlyBlockedSubstrings: seedPrediction.explicitlyBlockedSubstrings,
        blockAllTools: seedPrediction.blockAllTools,
        userMessageSnippet: seedPrediction.userMessageSnippet,
        timestamp: seedPrediction.timestamp ?? Date.now(),
        contextSwitch: seedPrediction.contextSwitch,
        questionIsStalling: seedPrediction.questionIsStalling,
      },
      forceCheckPending: scenario.seed_state.forceCheckPending,
      frustrationStreak: scenario.seed_state.frustrationStreak,
      currentWindowSize: scenario.seed_state.currentWindowSize,
      driftState: scenario.seed_state.driftState ?? {},
    };
    fs.writeFileSync(
      path.join(cacheDir, "state.json"),
      JSON.stringify({ version: 1, data: seeded }, null, 2),
    );
  }

  // Seed cache/tool-log.jsonl from scenario.seed_state.toolLog BEFORE
  // session-start fires so rules that read the tool log (drift-detect,
  // force-check-required's denial cache) observe the prior-turn state.
  // Defaults: ts = now - (reverse index * 1000ms) so older entries are older,
  // ms = 0 when omitted.
  if (scenario.seed_state.toolLog && scenario.seed_state.toolLog.length > 0) {
    const seedLog = scenario.seed_state.toolLog;
    const baseTs = Date.now();
    const lines = seedLog
      .map((entry, idx) => {
        const row = {
          ts: entry.ts ?? baseTs - (seedLog.length - idx) * 1000,
          tool: entry.tool,
          toolUseId: entry.toolUseId,
          batchPosition: entry.batchPosition,
          batchSize: entry.batchSize,
          path: entry.path,
          cmd: entry.cmd,
          status: entry.status,
          gate: entry.gate,
          reason: entry.reason,
          ms: entry.ms ?? 0,
        };
        return JSON.stringify(row);
      })
      .join("\n") + "\n";
    fs.writeFileSync(path.join(cacheDir, "tool-log.jsonl"), lines);
  }

  // Materialize plan file when seed_state.planFile is set.
  // Per-scenario plan files live under ~/.agent-framework/test-runs/scenarios/<name>/plans/
  // (not in the global ~/.claude/plans/) to avoid cross-scenario pollution.
  // AGENT_FRAMEWORK_PLAN_DIR is set in the env so session-utils.resolvePlanPath
  // finds the file there instead of ~/.claude/plans/.
  // The transcript's first synthesized JSONL line carries `slug: <slug>` (see
  // buildAllTranscriptLines) so resolvePlanPath -> extractSlugFromSession finds it.
  let planFileCleanupPath: string | null = null;
  if (scenario.seed_state.planFile) {
    const planDir = scenarioPlansDir(scenario.name);
    fs.mkdirSync(planDir, { recursive: true });
    const planPath = path.join(planDir, `${scenario.seed_state.planFile.slug}.md`);
    fs.writeFileSync(planPath, scenario.seed_state.planFile.content);
    planFileCleanupPath = planPath;
    process.env.AGENT_FRAMEWORK_PLAN_DIR = planDir;
  }

  const cwd = scenario.env?.cwd ?? outputDir;
  const sessionId = "scenario-" + scenario.name;
  const transcriptBasename = scenario.env?.subagent
    ? `agent-${scenario.name}.jsonl`
    : `scenario-${scenario.name}.jsonl`;
  const transcriptPath = path.join(cacheDir, transcriptBasename);

  const built = buildAllTranscriptLines(scenario, {
    transcriptPath,
    sessionId,
    cwd,
  });

  process.env.AGENT_FRAMEWORK_SESSION_DIR = cacheDir;
  const timeoutMs = scenario.env?.timeout_ms ?? 60000;
  const fanout = scenario.target.fanout === true;

  // Build the optional env extras passed into hook subprocesses. Only set
  // AGENT_FRAMEWORK_LLM_STUBS when the scenario declared the field.
  const envExtras = scenario.env?.llm_stubs
    ? { AGENT_FRAMEWORK_LLM_STUBS: JSON.stringify(scenario.env.llm_stubs) }
    : undefined;

  // exitCode is mutated below by the body's success/failure paths and the
  // catch handler. process.exit is invoked exactly once after the finally
  // block, ensuring planFile cleanup runs regardless of how the run ended.
  let exitCode = 0;

  try {
    if (!fanout) {
      // Single-hook mode: write the full (possibly cap-clipped) transcript
      // once and fire one hook.
      writeTranscriptSlice(transcriptPath, built.allLines, built.allLines.length);

      // Fire session-start preamble unless the target IS SessionStart.
      if (scenario.target.hook !== "SessionStart") {
        await runHook({
          hookScript: hookScript("session-start"),
          inputJson: JSON.stringify({
            hook_event_name: "SessionStart",
            source: "startup",
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd,
            permission_mode: scenario.env?.permission_mode ?? "default",
          }),
          env: buildEnv(cacheDir, cwd, envExtras),
          timeoutMs,
        });
      }

      // Capture tool-log.jsonl byte offset AFTER the session-start preamble
      // so scoring only reads the target hook's gate entry. Session-start
      // currently writes nothing to tool-log.jsonl; this is defensive
      // future-proofing in case that changes.
      const toolLogPath = path.join(cacheDir, "tool-log.jsonl");
      const toolLogOffset = fs.existsSync(toolLogPath)
        ? fs.statSync(toolLogPath).size
        : 0;

      const stdin = buildHookInput(scenario, {
        sessionId,
        transcriptPath,
        cwd,
        finalToolUses: built.finalToolUses,
      });
      const hookResult = await runHook({
        hookScript: hookScript(hookScriptName(scenario.target.hook)),
        inputJson: JSON.stringify(stdin),
        env: buildEnv(cacheDir, cwd, envExtras),
        timeoutMs,
      });

      const parsed = parseDecisionForHook(scenario.target.hook, hookResult, timeoutMs);
      const decision = parsed.decision;
      const tlReason = parsed.reason;
      const parseError = parsed.error;
      const { gate, reason: gateReason } = readToolLogEntriesAfterOffset(
        cacheDir,
        toolLogOffset,
      );

      const singleExpect = scenario.expect as {
        expected: string;
        by?: string;
      };
      const targetTool =
        scenario.target.hook === "PreToolUse" || scenario.target.hook === "PostToolUse"
          ? resolveToolUseBlock(scenario, built.finalToolUses)
          : null;
      const actualReason = tlReason ?? gateReason;
      const scoreCtx = targetTool
        ? { sessionDir: cacheDir, toolName: targetTool.name, toolInput: targetTool.input, actualReason }
        : { actualReason };
      const scored = scoreRichExpectation(decision, gate, singleExpect, scoreCtx);

      let predictionAssertions: PredictionAssertionResult[] | undefined;
      let predictionsPass = true;
      if (scenario.predictions) {
        predictionAssertions = await evaluateScenarioPredictions(
          cacheDir,
          scenario.predictions,
        );
        predictionsPass = predictionAssertions.every((a) => a.pass);
      }

      const pass = scored.pass && predictionsPass;
      const expectation_reality = computeExpectationReality(pass, sourceArg);
      const expectation_reality_last_run_at = new Date().toISOString();

      const result: ScenarioResult = {
        mode: "single",
        scenario: scenario.name,
        hook: scenario.target.hook,
        decision,
        gate,
        gate_expected: singleExpect.by,
        reason: scored.reason ?? tlReason ?? gateReason,
        expected: singleExpect.expected,
        pass,
        ms: Date.now() - started,
        error: parseError,
        transcript_path: transcriptPath,
        commit: getVersion(),
        batch_visible_through: scenario.target.batch_visible_through,
        ...(predictionAssertions ? { prediction_assertions: predictionAssertions } : {}),
        ...(scored.reason_must_results ? { reason_must_results: scored.reason_must_results } : {}),
        ...(actualReason !== undefined ? { actual_reason: actualReason } : {}),
        ...(scenario.env?.llm_stubs ? { llm_stubs_used: scenario.env.llm_stubs } : {}),
        expectation_reality,
        expectation_reality_last_run_at,
      };

      writeLastRun(
        scenario.name,
        scenarioPath,
        expectation_reality,
        expectation_reality_last_run_at,
      );

      fs.writeFileSync(
        path.join(outputDir, "report-scenario.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");

      exitCode = result.pass ? 0 : 1;
    } else {
      // ── Fan-out mode ───────────────────────────────────────────────────
      // Fire one PreToolUse hook per tool_use sub-line in the final
      // assistant_split, in order. Shared state (tool-log.jsonl, state.json,
      // gate reasoning) accumulates across fires in one
      // cacheDir — cache/ is NOT wiped between fires (the rmSync at the
      // start of main() runs once per scenario run, preserving the clean
      // slate invariant per run). Siblings inherit the leader's decision
      // via findBatchDecision reading the leader's on-disk tool-log
      // entry that the prior fire appended.
      const finalSplitSubLines = built.finalSplitSubLines;
      // Determine firstToolUseIdx from the materialized sub-lines (F5
      // already validated the shape).
      let firstToolUseIdx = -1;
      for (let j = 0; j < finalSplitSubLines.length; j++) {
        if (finalSplitSubLines[j].toolUse) {
          firstToolUseIdx = j;
          break;
        }
      }
      if (firstToolUseIdx === -1) {
        throw new Error(
          "internal: fan-out mode found no tool_use sub-line in the final assistant_split after validation",
        );
      }

      // Write every entry strictly before the final assistant_split to disk.
      writeTranscriptSlice(transcriptPath, built.allLines, built.finalSplitStart);

      // Fire session-start preamble once.
      await runHook({
        hookScript: hookScript("session-start"),
        inputJson: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "startup",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          permission_mode: scenario.env?.permission_mode ?? "default",
        }),
        env: buildEnv(cacheDir, cwd, envExtras),
        timeoutMs,
      });

      const toolLogPath = path.join(cacheDir, "tool-log.jsonl");
      const expectArray = scenario.expect as Array<{
        position: number;
        expected: string;
        by?: string;
        notes?: string;
        reason_must?: ReasonMustExpectation;
      }>;

      const fires: FanoutFireResult[] = [];
      for (let k = firstToolUseIdx; k < finalSplitSubLines.length; k++) {
        const sub = finalSplitSubLines[k];
        if (!sub.toolUse) {
          // F5 guarantees no text/thinking sub-lines at or after
          // firstToolUseIdx; this is defensive.
          throw new Error(
            `internal: fan-out sub-line ${k} has no tool_use after validation`,
          );
        }
        // Grow the on-disk file to include sub-lines [0..k].
        writeTranscriptSlice(
          transcriptPath,
          built.allLines,
          sub.absoluteIndex + 1,
        );

        const fireStart = Date.now();
        const toolLogOffsetForFire = fs.existsSync(toolLogPath)
          ? fs.statSync(toolLogPath).size
          : 0;

        const stdin = {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd,
          permission_mode: scenario.env?.permission_mode ?? "default",
          tool_name: sub.toolUse.name,
          tool_input: sub.toolUse.input,
          tool_use_id: sub.toolUse.id,
        };
        const hookResult = await runHook({
          hookScript: hookScript("pre-tool-use"),
          inputJson: JSON.stringify(stdin),
          env: buildEnv(cacheDir, cwd, envExtras),
          timeoutMs,
        });
        const parsed = parsePreToolUseDecision(hookResult, timeoutMs);
        const { gate, reason: gateReason } = readToolLogEntriesAfterOffset(
          cacheDir,
          toolLogOffsetForFire,
        );

        const expectEntry = expectArray.find((e) => e.position === k);
        let pass = true;
        let scoredReason: string | undefined;
        let scoredReasonMustResults: ReasonMustResult[] | undefined;
        let expected: string | undefined;
        let gateExpected: string | undefined;
        const fireActualReason = parsed.reason ?? gateReason;
        if (expectEntry) {
          expected = expectEntry.expected;
          gateExpected = expectEntry.by;
          const scored = scoreRichExpectation(
            parsed.decision,
            gate,
            {
              expected: expectEntry.expected,
              by: expectEntry.by,
              reason_must: expectEntry.reason_must,
            },
            {
              sessionDir: cacheDir,
              toolName: sub.toolUse.name,
              toolInput: sub.toolUse.input,
              actualReason: fireActualReason,
            },
          );
          pass = scored.pass;
          scoredReason = scored.reason;
          scoredReasonMustResults = scored.reason_must_results;
        }

        fires.push({
          position: k,
          tool_use_id: sub.toolUse.id,
          decision: parsed.decision,
          gate,
          reason: scoredReason ?? gateReason ?? parsed.error,
          ms: Date.now() - fireStart,
          expected,
          gate_expected: gateExpected,
          pass,
          asserted: expectEntry !== undefined,
          ...(scoredReasonMustResults ? { reason_must_results: scoredReasonMustResults } : {}),
          ...(fireActualReason !== undefined ? { actual_reason: fireActualReason } : {}),
          ...(scenario.env?.llm_stubs ? { llm_stubs_used: scenario.env.llm_stubs } : {}),
        });
      }

      // Predictions are session-scoped; check once at end of fan-out.
      let predictionAssertions: PredictionAssertionResult[] | undefined;
      let predictionsPass = true;
      if (scenario.predictions) {
        predictionAssertions = await evaluateScenarioPredictions(
          cacheDir,
          scenario.predictions,
        );
        predictionsPass = predictionAssertions.every((a) => a.pass);
      }

      const aggregatePass = fires.every((f) => f.pass) && predictionsPass;
      const expectation_reality = computeExpectationReality(aggregatePass, sourceArg);
      const expectation_reality_last_run_at = new Date().toISOString();
      const result: ScenarioResult = {
        mode: "fanout",
        scenario: scenario.name,
        hook: scenario.target.hook,
        fires,
        pass: aggregatePass,
        ms: Date.now() - started,
        transcript_path: transcriptPath,
        commit: getVersion(),
        ...(predictionAssertions ? { prediction_assertions: predictionAssertions } : {}),
        ...(scenario.env?.llm_stubs ? { llm_stubs_used: scenario.env.llm_stubs } : {}),
        expectation_reality,
        expectation_reality_last_run_at,
      };

      writeLastRun(
        scenario.name,
        scenarioPath,
        expectation_reality,
        expectation_reality_last_run_at,
      );

      fs.writeFileSync(
        path.join(outputDir, "report-scenario.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");

      exitCode = aggregatePass ? 0 : 1;
    }
  } catch (err) {
    console.error(
      "scenario run failed: " +
        (err instanceof Error ? err.message : String(err)),
    );
    exitCode = 2;
  } finally {
    if (planFileCleanupPath) {
      try {
        fs.unlinkSync(planFileCleanupPath);
      } catch {
        // Ignore cleanup errors — best-effort. The seed_state guard refuses
        // to clobber an existing file at the same path on the next run.
      }
    }
  }

  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
