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
  subagent: boolean = false,
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
    subagent,
    toolCallCount: 0,
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

  it("fastDenies 'Warning:' at level 0 once 4 allowed edits exist", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith("Warning: 4 edits to")).toBe(true);
  });

  it("allows at level 0 with only 3 allowed edits", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    const result = await driftDetectRule.check(ctx);
    expect(result).toBeNull();
  });

  it("fastDenies 'Final Warning:' at level 1 once bypass window (3) expires", async () => {
    writeToolLog(sessionDir, Array.from({ length: 7 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 3 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith("Final Warning: 7 edits to")).toBe(true);
  });

  it("fastDenies 'Error:' at level 2 once bypass window (1) expires", async () => {
    writeToolLog(sessionDir, Array.from({ length: 9 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2, allowedSinceLevelChange: 1 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith("Error: 9 edits to")).toBe(true);
  });

  it("fastDenies 'Error:' on every attempt at level 3", async () => {
    writeToolLog(sessionDir, Array.from({ length: 12 }, () => allowedEdit()));
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } },
    });
    const result = await driftDetectRule.check(ctx);
    expect(result).not.toBeNull();
    const { fastDeny } = result as { fastDeny: string };
    expect(fastDeny.startsWith("Error: 12 edits to")).toBe(true);
  });

  it("returns null for subagent context without reading tool log", async () => {
    writeToolLog(sessionDir, [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()]);
    const ctx = await buildCtx(sessionDir, { driftState: {} }, undefined, "Edit", true);
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

  it("advances level 0 → 1 on 'Warning:' reason, resetting allowedSinceLevelChange", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} });
    await driftDetectRule.onDenialConfirmed!(ctx, "Warning: 4 edits to \"x\" detected - possible loop");
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 1, allowedSinceLevelChange: 0 });
  });

  it("advances level 1 → 2 on 'Final Warning:' reason", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 1, allowedSinceLevelChange: 3 } },
    });
    await driftDetectRule.onDenialConfirmed!(
      ctx,
      "Final Warning: 7 edits to \"x\" detected - possible loop",
    );
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 2, allowedSinceLevelChange: 0 });
  });

  it("advances level 2 → 3 on 'Error:' reason", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 2, allowedSinceLevelChange: 1 } },
    });
    await driftDetectRule.onDenialConfirmed!(ctx, "Error: 9 edits to \"x\" detected - possible loop");
    const after = await loadDriftState(sessionDir);
    expect(after[TARGET]).toEqual({ level: 3, allowedSinceLevelChange: 0 });
  });

  it("clamps at level 3 on subsequent 'Error:' denials", async () => {
    const ctx = await buildCtx(sessionDir, {
      driftState: { [TARGET]: { level: 3, allowedSinceLevelChange: 0 } },
    });
    await driftDetectRule.onDenialConfirmed!(ctx, "Error: 12 edits to \"x\" detected");
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
    await driftDetectRule.onDenialConfirmed!(ctx, "Warning: 4 edits to \"x\" detected");
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });

  it("does nothing for non-edit tools", async () => {
    const ctx = await buildCtx(sessionDir, { driftState: {} }, { file_path: TARGET }, "Read");
    await driftDetectRule.onDenialConfirmed!(ctx, "Warning: 4 edits to \"x\" detected");
    const after = await loadDriftState(sessionDir);
    expect(after).toEqual({});
  });
});
