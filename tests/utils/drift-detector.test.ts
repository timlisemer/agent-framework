import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/utils/drift-detector.js";
import type { DriftTargetState, ToolLogEntry } from "../../src/utils/session-store.js";

const TARGET = "/home/tim/.claude/plans/drift.md";

function allowedEdit(path: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path, status: "allowed", gate: "edit-intent", ms: 0 };
}

describe("detectDrift - graduated repetition block", () => {
  it("allows at level 0 when fewer than 4 allowed edits exist", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("denies with 'Warning:' prefix at level 0 once 4 allowed edits exist", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith("Warning: 4 edits to")).toBe(true);
    expect(signal.reason).toContain("possible loop or thrashing");
  });

  it("allows at level 1 until 3 free edits are consumed", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1, allowedSinceLevelChange: 2 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 10 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with 'Final Warning:' prefix when level 1 bypass window expires", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1, allowedSinceLevelChange: 3 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 7 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith("Final Warning: 7 edits to")).toBe(true);
  });

  it("allows at level 2 for the single free edit", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2, allowedSinceLevelChange: 0 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 8 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with 'Error:' prefix when level 2 bypass window expires", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2, allowedSinceLevelChange: 1 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 9 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith("Error: 9 edits to")).toBe(true);
  });

  it("denies with 'Error:' prefix on every attempt at level 3", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 3, allowedSinceLevelChange: 0 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 12 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith("Error: 12 edits to")).toBe(true);
  });

  it("ignores denied edits when counting allowed edits at level 0", () => {
    const log: ToolLogEntry[] = [
      allowedEdit(),
      allowedEdit(),
      allowedEdit(),
      { ts: 0, tool: "Edit", path: TARGET, status: "denied", gate: "drift-block", ms: 0 },
    ];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("does not trigger for non-edit tools", () => {
    const log: ToolLogEntry[] = Array.from({ length: 10 }, () => allowedEdit());
    const signal = detectDrift("Read", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("works without a driftState argument (backward compatible)", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith("Warning:")).toBe(true);
  });
});
