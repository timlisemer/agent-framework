import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/utils/drift-detector.js";
import type { DriftTargetState, ToolLogEntry } from "../../src/utils/session-store.js";

const TARGET = "/home/tim/.claude/plans/drift.md";

function allowedEdit(path: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path, status: "allowed", gate: "edit-intent", ms: 0 };
}

describe("detectDrift - graduated repetition block", () => {
  it("allows at level 0 when only 4 allowed edits exist", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("denies with level-0 consolidation nudge once 5 allowed edits exist", () => {
    const log: ToolLogEntry[] = Array.from({ length: 5 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`5 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("stop making many small edits");
    expect(signal.reason).toContain("ONE Edit, MultiEdit, or Write call");
    expect(signal.reason).not.toContain("you are thrashing");
  });

  it("allows at level 1 below 10 effective edits", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 9 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with final warning at level 1 once 10 effective edits exist", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 10 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`10 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("final warning");
    expect(signal.reason).not.toContain("you are thrashing");
  });

  it("allows at level 2 below 10 effective edits", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 9 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with final warning at level 2 once 10 effective edits exist", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 10 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`10 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("final warning");
    expect(signal.reason).not.toContain("you are thrashing");
  });

  it("applies reduction credits to the effective count", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 12 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift, {
      driftReductionCredits: { [TARGET]: 3 },
    });
    expect(signal.detected).toBe(false);
  });

  it("ignores denied edits when counting allowed edits at level 0", () => {
    const log: ToolLogEntry[] = [
      allowedEdit(),
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

  it("does not turn prior Bash denials into a separate drift lockout", () => {
    const log: ToolLogEntry[] = [
      { ts: 0, tool: "Bash", cmd: "cargo test", status: "denied", gate: "blacklist", ms: 0 },
      { ts: 1, tool: "Bash", cmd: "npx vitest", status: "denied", gate: "blacklist", ms: 0 },
    ];
    const signal = detectDrift("Bash", { command: "npm test" }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("works without a driftState argument (backward compatible)", () => {
    const log: ToolLogEntry[] = Array.from({ length: 5 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log);
    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain(`5 edits to "${TARGET}"`);
    expect(signal.reason).toContain("stop making many small edits");
  });
});
