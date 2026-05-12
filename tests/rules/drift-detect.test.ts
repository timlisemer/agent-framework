import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { driftDetectRule } from "../../src/rules/drift-detect.js";
import type { RuleContext } from "../../src/rules/types.js";
import {
  getSessionState,
  sessionStateDefaults,
  type SessionState,
  type ToolLogEntry,
  type DriftTargetState,
} from "../../src/utils/session-store.js";

const TARGET = "/home/tim/.claude/plans/drift-rule-test.md";

function writeToolLog(sessionDir: string, entries: ToolLogEntry[]): void {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  fs.writeFileSync(path.join(sessionDir, "tool-log.jsonl"), lines);
}

function allowedEdit(pathValue: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path: pathValue, status: "allowed", gate: "edit-intent", ms: 0 };
}

async function buildCtx(
  sessionDir: string,
  overrides: Partial<SessionState>,
  toolInput: unknown = { file_path: TARGET, old_string: "foo", new_string: "bar" },
  toolName: string = "Edit",
): Promise<RuleContext> {
  const stateManager = getSessionState(sessionDir);
  const state: SessionState = { ...sessionStateDefaults(), ...overrides };
  await stateManager.save(state);
  return {
    toolName,
    toolInput,
    toolUseId: "toolu_test",
    projectDir: sessionDir,
    transcriptPath: path.join(sessionDir, "transcript.jsonl"),
    sessionDir,
    sessionId: "test-session",
    state,
    stateManager,
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
  };
}

async function loadDriftState(
  sessionDir: string,
): Promise<Record<string, DriftTargetState>> {
  const loaded = await getSessionState(sessionDir).load();
  return loaded.driftState ?? {};
}

describe("driftDetectRule.check — end-to-end level behavior", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("fastDenies level-0 nudge once 4 allowed edits exist", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`4 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("stop making many small edits");
  });

  it("allows at level 0 with only 3 allowed edits", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });

  it("fastDenies last-nudge message at level 1 once bypass window (3) expires", async () => {
    writeToolLog(sessionDir, Array.from({ length: 7 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 3 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`7 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("last nudge");
  });

  it("fastDenies thrashing message at level 2 once bypass window (1) expires", async () => {
    writeToolLog(sessionDir, Array.from({ length: 9 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2, allowedSinceLevelChange: 1 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`9 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("you are thrashing");
  });

  it("fastDenies thrashing message on every attempt at level 3", async () => {
    writeToolLog(sessionDir, Array.from({ length: 12 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith(`12 edits to "${TARGET}"`)).toBe(true);
    expect(fastDeny).toContain("you are thrashing");
  });

  it("ignores log entries older than lastUserMessageTimestamp (per-turn reset)", async () => {
    writeToolLog(sessionDir, [
      { ts: 100, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 200, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 300, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
      { ts: 400, tool: "Edit", path: TARGET, status: "allowed", gate: "edit-intent", ms: 0 },
    ]);
    // lastUserMessageTimestamp=500 → all four prior edits are filtered out, so
    // the count drops from 4 to 0 and drift no longer fires.
    const ctx = await buildCtx(sessionDir, {
      driftState: {},
      lastUserMessageTimestamp: 500,
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });
});

describe("driftDetectRule.check — allow-path state increments", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("increments allowedSinceLevelChange at level 1 when within bypass window", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 1 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1, allowedSinceLevelChange: 2 });
  });

  it("increments allowedSinceLevelChange at level 2 when within bypass window", async () => {
    writeToolLog(sessionDir, [allowedEdit()]);
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2, allowedSinceLevelChange: 0 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2, allowedSinceLevelChange: 1 });
  });

  it("does NOT increment at level 0 (no level change yet)", async () => {
    writeToolLog(sessionDir, [allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toBeUndefined();
  });

  it("does NOT increment at level 3 (terminal error state)", async () => {
    writeToolLog(sessionDir, []);
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } },
    });
    // At level 3 the rule fastDenies, so we bypass the fastDeny path by using a
    // non-edit tool to exercise the allow-path branch without triggering drift.
    const readCtx = await buildCtx(
      sessionDir,
      { driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } } },
      { file_path: TARGET },
      "Read",
    );
    const result = await driftDetectRule.check(readCtx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 3, allowedSinceLevelChange: 0 });
    void ctx;
  });

  it("does not touch driftState for non-edit tools", async () => {
    writeToolLog(sessionDir, []);
    const ctx = await buildCtx(
      sessionDir,
      { driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 1 } } },
      { file_path: TARGET },
      "Read",
    );
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1, allowedSinceLevelChange: 1 });
  });
});

describe("driftDetectRule.onDenialConfirmed — level transitions", () => {
  let sessionDir: string;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "drift-detect-rule-"));
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("advances level 0 → 1 on a level-0 drift reason, resetting allowedSinceLevelChange", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `4 edits to "${TARGET}" — stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1, allowedSinceLevelChange: 0 });
  });

  it("advances level 1 → 2 on a level-1 drift reason", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 3 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `7 edits to "${TARGET}" — last nudge.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2, allowedSinceLevelChange: 0 });
  });

  it("advances level 2 → 3 on a level-2 drift reason", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2, allowedSinceLevelChange: 1 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `9 edits to "${TARGET}" — you are thrashing.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 3, allowedSinceLevelChange: 0 });
  });

  it("clamps at level 3 on subsequent thrashing denials", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `12 edits to "${TARGET}" — you are thrashing.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 3, allowedSinceLevelChange: 0 });
  });

  it("ignores non-drift denial reasons (e.g. workaround escalation)", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 2 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      "2 recent denials targeting \"foo\" - possible workaround escalation",
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1, allowedSinceLevelChange: 2 });
  });

  it("does nothing when tool input has no target", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} }, {});
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `4 edits to "${TARGET}" — stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });

  it("does nothing for non-edit tools", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} }, { file_path: TARGET }, "Read");
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      `4 edits to "${TARGET}" — stop making many small edits.`,
    );
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });
});
