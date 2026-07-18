import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { driftDetectRule } from "../../src/rules/drift-detect.js";
import {
  sessionStateDefaults,
  type SessionState,
  type ToolLogEntry,
  type DriftTargetState,
} from "../helpers/session-workflow.js";
import { CacheManager } from "../../src/utils/cache-manager.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const TARGET = "/home/tim/.claude/plans/drift-rule-test.md";
const toolHistoryBySession = new Map<string, ToolLogEntry[]>();

function testStateManager(sessionDir: string): CacheManager<SessionState> {
  return new CacheManager({
    filePath: path.join(sessionDir, "workflow-state.json"),
    defaultData: sessionStateDefaults,
  });
}

function setToolHistory(sessionDir: string, entries: ToolLogEntry[]): void {
  toolHistoryBySession.set(sessionDir, entries);
}

function allowedEdit(pathValue: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path: pathValue, status: "allowed", gate: "edit-intent", ms: 0 };
}

function allowedMultiEdit(paths: string[]): ToolLogEntry {
  return { ts: 0, tool: "Edit", path: paths[0], paths, status: "allowed", gate: "edit-intent", ms: 0 };
}

async function buildCtx(
  sessionDir: string,
  overrides: Partial<SessionState>,
  toolInput: unknown = { file_path: TARGET, old_string: "foo", new_string: "bar" },
  toolName: string = "Edit",
){
  const stateManager = testStateManager(sessionDir);
  const state: SessionState = { ...sessionStateDefaults(), ...overrides };
  await stateManager.save(state);
  return makeRuleContext({
    toolName,
    toolInput,
    toolUseId: "toolu_test",
    projectDir: sessionDir,
    transcriptPath: path.join(sessionDir, "transcript.jsonl"),
    sessionDir,
    sessionId: "test-session",
    state,
    stateManager,
    toolHistory: toolHistoryBySession.get(sessionDir) ?? [],
  });
}

async function loadDriftState(
  sessionDir: string,
): Promise<Record<string, DriftTargetState>> {
  const loaded = await testStateManager(sessionDir).load();
  return loaded.driftState ?? {};
}

describe("driftDetectRule.check - end-to-end level behavior", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
    toolHistoryBySession.set(sessionDir, []);
  });

  afterEach(() => {
    toolHistoryBySession.delete(sessionDir);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("fastDenies level-0 nudge once 5 allowed edits exist", async () => {
    setToolHistory(sessionDir, Array.from({ length: 5 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`5 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("stop making many small edits");
    expect(fastDeny).not.toContain("you are thrashing");
  });

  it("allows repeated same-file edits when prediction explicitly describes multi-region work", async () => {
    setToolHistory(sessionDir, Array.from({ length: 5 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: {},
      currentPrediction: {
        mood: "satisfied",
        trust: "high",
        intent:
          "User approved implementing the fix across non-adjacent regions of this file.",
        blockedIntent: "",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: "fix it",
        timestamp: Date.now(),
      },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });

  it("fastDenies when the repeated target is not the first file_path", async () => {
    const first = "/home/tim/project/src/first.ts";
    setToolHistory(sessionDir, [
      allowedMultiEdit([`${first}.1`, TARGET]),
      allowedMultiEdit([`${first}.2`, TARGET]),
      allowedMultiEdit([`${first}.3`, TARGET]),
      allowedMultiEdit([`${first}.4`, TARGET]),
      allowedMultiEdit([`${first}.5`, TARGET]),
    ]);
    const ctx = await buildCtx(sessionDir, { driftState: {} }, {
      file_path: first,
      file_paths: [first, TARGET],
      old_string: "foo",
      new_string: "bar",
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`5 edits to "${TARGET}"`)).toBe(true);
  });

  it("allows at level 0 with only 4 allowed edits", async () => {
    setToolHistory(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });

  it("fastDenies final warning at level 1 once 10 effective edits exist", async () => {
    setToolHistory(sessionDir, Array.from({ length: 10 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`10 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("final warning");
    expect(fastDeny).not.toContain("you are thrashing");
  });

  it("fastDenies final warning at level 2 once 10 effective edits exist", async () => {
    setToolHistory(sessionDir, Array.from({ length: 10 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`10 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("final warning");
    expect(fastDeny).not.toContain("you are thrashing");
  });

  it("applies reduction credits when checking repeated edit counts", async () => {
    setToolHistory(sessionDir, Array.from({ length: 12 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1 } },
      driftReductionCredits: { [TARGET]: 3 },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });

  it("ignores log entries older than lastUserMessageTimestamp (per-turn reset)", async () => {
    setToolHistory(sessionDir, [
      { ts: 100, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 200, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 300, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 400, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 450, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
    ]);
    // lastUserMessageTimestamp=500 filters all five prior edits, so the count
    // drops from 5 to 0 and drift no longer fires.
    const ctx = await buildCtx(sessionDir, {
      driftState: {},
      lastUserMessageTimestamp: 500,
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });
});

describe("driftDetectRule.check - allow-path state preservation", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
    toolHistoryBySession.set(sessionDir, []);
  });

  afterEach(() => {
    toolHistoryBySession.delete(sessionDir);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("does not mutate level 1 state on allowed edits below the final-warning threshold", async () => {
    setToolHistory(sessionDir, [allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1 });
  });

  it("does not mutate level 2 state on allowed edits below the final-warning threshold", async () => {
    setToolHistory(sessionDir, [allowedEdit()]);
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2 });
  });

  it("does NOT increment at level 0 (no level change yet)", async () => {
    setToolHistory(sessionDir, [allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toBeUndefined();
  });

  it("does not touch driftState for non-edit tools", async () => {
    setToolHistory(sessionDir, []);
    const ctx = await buildCtx(
      sessionDir,
      { driftState: { [TARGET]: { level: 1 } } },
      { file_path: TARGET },
      "Read",
    );
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1 });
  });
});

describe("driftDetectRule.onDenialConfirmed - level transitions", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
    toolHistoryBySession.set(sessionDir, []);
  });

  afterEach(() => {
    toolHistoryBySession.delete(sessionDir);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("advances level 0 to 1 on a level-0 drift reason", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `5 edits to "${TARGET}" - stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1 });
  });

  it("advances level 1 to 2 on a level-1 drift reason", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `10 edits to "${TARGET}" - final warning.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2 });
  });

  it("clamps at level 2 on subsequent drift denials", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `10 edits to "${TARGET}" - final warning.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2 });
  });

  it("ignores non-drift denial reasons", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      "A different rule denied this tool call.",
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1 });
  });

  it("does nothing when tool input has no target", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} }, {});
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `5 edits to "${TARGET}" - stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });

  it("does nothing for non-edit tools", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} }, { file_path: TARGET }, "Read");
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `5 edits to "${TARGET}" - stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });
});
