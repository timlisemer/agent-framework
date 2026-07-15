import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  onUserPromptTurn,
  reduceDriftDetectionWindow,
  resetDriftDetectionWindow,
} from "../../src/scenario/lifecycle.js";
import {
  getSessionState,
  sessionStateDefaults,
  appendToolLog,
  readToolLogEntries,
} from "../../src/utils/session-store.js";

describe("onUserPromptTurn", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lifecycle-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("clears decision caches and state transients but preserves forensic tool log", async () => {
    fs.writeFileSync(path.join(tempDir, "gate-reasoning.json"), "{}");
    await appendToolLog(tempDir, {
      ts: Date.now(),
      tool: "Bash",
      status: "denied",
      gate: "tool-approve",
      reason: "previous denial",
      ms: 1,
    });

    const stateManager = getSessionState(tempDir);
    await stateManager.save({
      ...sessionStateDefaults(),
      currentEditIntent: true,
      editIntentOverturnCount: 2,
      respondFirstChecked: true,
      driftState: {
        "/tmp/file.ts": { level: 2 },
      },
      driftReductionCredits: { "/tmp/file.ts": 3 },
      lastProcessedPlanApprovalToolUseId: "toolu_plan",
    });

    await onUserPromptTurn(tempDir);

    expect(fs.existsSync(path.join(tempDir, "gate-reasoning.json"))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, "tool-log.jsonl"))).toBe(true);

    const state = await stateManager.load();
    expect(state.previousEditIntent).toBe(true);
    expect(state.currentEditIntent).toBeNull();
    expect(state.editIntentOverturnCount).toBe(0);
    expect(state.respondFirstChecked).toBe(false);
    expect(state.driftState).toEqual({});
    expect(state.driftReductionCredits).toEqual({});
    expect(state.lastProcessedPlanApprovalToolUseId).toBeNull();
    expect(state.lastUserMessageTimestamp).toBeGreaterThan(0);
  });

  it("resets only the drift window and preserves forensic tool log", async () => {
    await appendToolLog(tempDir, {
      ts: Date.now(),
      tool: "Edit",
      path: "/tmp/file.ts",
      status: "allowed",
      gate: "all-rules",
      ms: 1,
    });

    const stateManager = getSessionState(tempDir);
    await stateManager.save({
      ...sessionStateDefaults(),
      currentEditIntent: true,
      editIntentOverturnCount: 2,
      respondFirstChecked: true,
      driftState: {
        "/tmp/file.ts": { level: 2 },
      },
      driftReductionCredits: { "/tmp/file.ts": 3 },
      lastProcessedPlanApprovalToolUseId: "toolu_plan",
      lastUserMessageTimestamp: 123,
    });

    await resetDriftDetectionWindow(tempDir);

    expect(fs.existsSync(path.join(tempDir, "tool-log.jsonl"))).toBe(true);

    const state = await stateManager.load();
    expect(state.currentEditIntent).toBe(true);
    expect(state.editIntentOverturnCount).toBe(2);
    expect(state.respondFirstChecked).toBe(true);
    expect(state.lastProcessedPlanApprovalToolUseId).toBe("toolu_plan");
    expect(state.driftState).toEqual({});
    expect(state.driftReductionCredits).toEqual({});
    expect(state.lastUserMessageTimestamp).toBeGreaterThan(123);
  });

  it("reduces the drift window by per-target credits without deleting tool-log entries", async () => {
    const target = "/tmp/file.ts";
    const other = "/tmp/other.ts";
    for (let i = 0; i < 55; i++) {
      await appendToolLog(tempDir, {
        ts: i,
        tool: "Edit",
        path: i < 52 ? target : other,
        status: "allowed",
        gate: "all-rules",
        ms: 1,
      });
    }

    const stateManager = getSessionState(tempDir);
    await stateManager.save({
      ...sessionStateDefaults(),
      lastUserMessageTimestamp: 10,
      driftReductionCredits: { [target]: 1 },
    });

    await reduceDriftDetectionWindow(tempDir, 3);

    const state = await stateManager.load();
    expect(state.driftReductionCredits[target]).toBe(4);
    expect(state.driftReductionCredits[other]).toBe(3);
    expect(readToolLogEntries(tempDir, 100)).toHaveLength(55);
  });

  it("reads recent tool-log entries from a large log tail", () => {
    const oldEntries = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        ts: i,
        tool: "Edit",
        path: `/tmp/old-${i}.ts`,
        status: "allowed",
        gate: "all-rules",
        reason: "x".repeat(8192),
        ms: 1,
      })
    );
    const largeReason = "x".repeat(400 * 1024);
    const recentEntries = [
      { ts: 201, tool: "Edit", path: "/tmp/recent-1.ts", status: "allowed", gate: "all-rules", reason: largeReason, ms: 1 },
      { ts: 202, tool: "Edit", path: "/tmp/recent-2.ts", status: "allowed", gate: "all-rules", reason: largeReason, ms: 1 },
      { ts: 203, tool: "Edit", path: "/tmp/recent-3.ts", status: "allowed", gate: "all-rules", reason: largeReason, ms: 1 },
    ];
    fs.writeFileSync(
      path.join(tempDir, "tool-log.jsonl"),
      `${oldEntries.join("\n")}\n${recentEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );

    expect(readToolLogEntries(tempDir, 3).map((entry) => entry.path)).toEqual([
      "/tmp/recent-1.ts",
      "/tmp/recent-2.ts",
      "/tmp/recent-3.ts",
    ]);
  });
});
