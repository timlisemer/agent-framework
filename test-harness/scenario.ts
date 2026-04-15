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
import {
  type FanoutFireResult,
  type HookEventName,
  type Scenario,
  type ScenarioBlock,
  type ScenarioResult,
  validateScenario,
} from "./lib/types.js";
import { runHook, cleanupBackgroundProcesses } from "./lib/harness.js";
import {
  buildEnv,
  getVersion,
  hookScript,
  parseExitCodeDecision,
  parsePreToolUseDecision,
  parseStopDecision,
  readToolLogEntriesAfterOffset,
  scoreRichExpectation,
} from "./lib/hook-runner.js";

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
      const prompt =
        scenario.target.prompt_override ??
        (typeof lastUser.content === "string" ? lastUser.content : "");
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
      return parseExitCodeDecision(hookResult, timeoutMs);
  }
}

async function main() {
  const scenarioPath = getArg("scenario", true)!;
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
  const scenarioRoot = path.dirname(scenarioPath);
  const cacheDir = path.join(scenarioRoot, "cache");
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

  const cwd = scenario.env?.cwd ?? scenarioRoot;
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
          env: buildEnv(cacheDir, cwd),
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
        env: buildEnv(cacheDir, cwd),
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
      const scored = scoreRichExpectation(decision, gate, singleExpect);

      const result: ScenarioResult = {
        mode: "single",
        scenario: scenario.name,
        hook: scenario.target.hook,
        decision,
        gate,
        gate_expected: singleExpect.by,
        reason: scored.reason ?? tlReason ?? gateReason,
        expected: singleExpect.expected,
        pass: scored.pass,
        ms: Date.now() - started,
        error: parseError,
        transcript_path: transcriptPath,
        commit: getVersion(),
        batch_visible_through: scenario.target.batch_visible_through,
      };

      fs.writeFileSync(
        path.join(scenarioRoot, "report-scenario.json"),
        JSON.stringify(result, null, 2) + "\n",
      );
      console.log(JSON.stringify(result, null, 2));

      await cleanupBackgroundProcesses(cacheDir);
      process.exit(scored.pass ? 0 : 1);
    }

    // ── Fan-out mode ───────────────────────────────────────────────────
    // Fire one PreToolUse hook per tool_use sub-line in the final
    // assistant_split, in order. Shared state (tool-log.jsonl, state.json,
    // gate reasoning, summary cache) accumulates across fires in one
    // cacheDir — cache/ is NOT wiped between fires (the rmSync at the
    // start of main() runs once per scenario run, preserving the clean
    // slate invariant per run). Siblings inherit the leader's decision
    // via waitForBatchLeader reading the leader's on-disk tool-log
    // entry that the prior fire appended.
    //
    // NOTE: orphan summary-updater pid files. src/utils/spawn-background.ts
    // keys pid files by dedupKey so a later fire's child pid file may
    // overwrite an earlier fire's. Any already-exited earlier child is
    // harmless; a still-running earlier child becomes unreachable from
    // cleanupBackgroundProcesses and runs until it exits on its own.
    // Summary-updater children exit quickly so this is benign.
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
      env: buildEnv(cacheDir, cwd),
      timeoutMs,
    });

    const toolLogPath = path.join(cacheDir, "tool-log.jsonl");
    const expectArray = scenario.expect as Array<{
      position: number;
      expected: string;
      by?: string;
      notes?: string;
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
        env: buildEnv(cacheDir, cwd),
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
      let expected: string | undefined;
      let gateExpected: string | undefined;
      if (expectEntry) {
        expected = expectEntry.expected;
        gateExpected = expectEntry.by;
        const scored = scoreRichExpectation(parsed.decision, gate, {
          expected: expectEntry.expected,
          by: expectEntry.by,
        });
        pass = scored.pass;
        scoredReason = scored.reason;
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
      });
    }

    const aggregatePass = fires.every((f) => f.pass);
    const result: ScenarioResult = {
      mode: "fanout",
      scenario: scenario.name,
      hook: scenario.target.hook,
      fires,
      pass: aggregatePass,
      ms: Date.now() - started,
      transcript_path: transcriptPath,
      commit: getVersion(),
    };

    fs.writeFileSync(
      path.join(scenarioRoot, "report-scenario.json"),
      JSON.stringify(result, null, 2) + "\n",
    );
    console.log(JSON.stringify(result, null, 2));

    await cleanupBackgroundProcesses(cacheDir);
    process.exit(aggregatePass ? 0 : 1);
  } catch (err) {
    console.error(
      "scenario run failed: " +
        (err instanceof Error ? err.message : String(err)),
    );
    await cleanupBackgroundProcesses(cacheDir);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
