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
 * Materialize the scenario's `transcript` array into a real JSONL file
 * at `ctx.transcriptPath`. Every entry gets the shape real Claude Code
 * writes, so `readTranscriptExact` and downstream hooks treat it as a
 * regular session transcript.
 *
 * Returns the list of resolved tool_use block ids present in the final
 * assistant entry (for target resolution).
 */
function materializeTranscript(
  scenario: Scenario,
  ctx: MaterializeCtx,
): Array<{ id: string; name: string; input: Record<string, unknown> }> {
  const permissionMode = scenario.env?.permission_mode ?? "default";
  const lines: string[] = [];
  let prevUuid: string | null = null;
  let baseTs = Date.now();
  let toolUseCounter = 0;
  // Resolved blocks from the final assistant entry (for target lookup).
  const finalAssistantToolUses: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }> = [];
  const finalIndex = scenario.transcript.length - 1;

  const nextToolUseId = () => {
    toolUseCounter += 1;
    return `toolu_scenario_${toolUseCounter}`;
  };

  // Emit one materialized jsonl object for a given set of blocks + msg id.
  const emitAssistantLine = (
    blocks: ScenarioBlock[],
    msgId: string,
    entryIndex: number,
    lineOffset: number,
    collectFinalToolUses: boolean,
  ): void => {
    materializeBlocks(blocks, nextToolUseId);
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    const uuid = crypto.randomUUID();
    const timestamp = new Date(baseTs + entryIndex * 100 + lineOffset * 10).toISOString();
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
    lines.push(JSON.stringify(line));
    if (collectFinalToolUses) {
      for (const b of blocks) {
        if (b.type === "tool_use") {
          finalAssistantToolUses.push({
            id: (b as { id: string }).id,
            name: b.name,
            input: b.input,
          });
        }
      }
    }
  };

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
      lines.push(JSON.stringify(line));
    } else if (entry.role === "assistant") {
      emitAssistantLine(entry.content, `msg_scenario_${i}`, i, 0, isFinal);
    } else {
      // assistant_split — one jsonl line per lines[j], all sharing msg_id.
      // Order preserved: caller decides whether text precedes tool_use.
      //
      // When this is the FINAL entry and target.batch_visible_through is
      // set, stop flushing after that 0-based sub-line index. This
      // reproduces the pre-flush on-disk state at the instant sub-line
      // `cap`'s hook fires in real Claude Code (only positions 0..cap
      // are on disk yet). The final tool_use collection in
      // emitAssistantLine is transitively shortened because
      // collectFinalToolUses only runs inside emitAssistantLine calls
      // that actually execute — do NOT separately "fix" one without
      // the other. See TranscriptEntry / AssistantGroup in
      // src/utils/transcript.ts for the on-disk shape this must match.
      const lastIdx = entry.lines.length - 1;
      const cap =
        isFinal && scenario.target.batch_visible_through !== undefined
          ? scenario.target.batch_visible_through
          : lastIdx;
      for (let j = 0; j <= cap; j++) {
        emitAssistantLine(entry.lines[j].blocks, entry.msg_id, i, j, isFinal);
      }
    }
  }

  fs.writeFileSync(ctx.transcriptPath, lines.join("\n") + "\n");
  return finalAssistantToolUses;
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

  const finalToolUses = materializeTranscript(scenario, {
    transcriptPath,
    sessionId,
    cwd,
  });

  process.env.AGENT_FRAMEWORK_SESSION_DIR = cacheDir;
  const timeoutMs = scenario.env?.timeout_ms ?? 60000;

  try {
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
      finalToolUses,
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

    const scored = scoreRichExpectation(decision, gate, scenario.expect as {
      expected: string;
      by?: string;
    });

    const result: ScenarioResult = {
      scenario: scenario.name,
      hook: scenario.target.hook,
      decision,
      gate,
      gate_expected: scenario.expect.by,
      reason: scored.reason ?? tlReason ?? gateReason,
      expected: scenario.expect.expected,
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
