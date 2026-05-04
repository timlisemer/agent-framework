import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/utils/drift-detector.js";
import type { DriftTargetState, ToolLogEntry } from "../../src/utils/session-store.js";

const TARGET = "/home/tim/.claude/plans/drift.md";

function allowedEdit(path: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path, status: "allowed", gate: "edit-intent", ms: 0 };
}

function deniedBash(command: string, reason: string): ToolLogEntry {
  return { ts: 0, tool: "Bash", cmd: command, status: "denied", gate: "tool-approve", reason, ms: 0 };
}

describe("detectDrift - graduated repetition block", () => {
  it("allows at level 0 when fewer than 4 allowed edits exist", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(false);
  });

  it("denies with level-0 consolidation nudge once 4 allowed edits exist", () => {
    const log: ToolLogEntry[] = [allowedEdit(), allowedEdit(), allowedEdit(), allowedEdit()];
    const signal = detectDrift("Edit", { file_path: TARGET }, log, {});
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`4 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("stop making many small edits");
    expect(signal.reason).toContain("ONE Edit/Write call");
  });

  it("allows at level 1 until 3 free edits are consumed", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1, allowedSinceLevelChange: 2 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 10 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with last-nudge message when level 1 bypass window expires", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 1, allowedSinceLevelChange: 3 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 7 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`7 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("last nudge");
  });

  it("allows at level 2 for the single free edit", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2, allowedSinceLevelChange: 0 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 8 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(false);
  });

  it("denies with thrashing message when level 2 bypass window expires", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 2, allowedSinceLevelChange: 1 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 9 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`9 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("you are thrashing");
  });

  it("denies with thrashing message on every attempt at level 3", () => {
    const drift: Record<string, DriftTargetState> = {
      [TARGET]: { level: 3, allowedSinceLevelChange: 0 },
    };
    const log: ToolLogEntry[] = Array.from({ length: 12 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log, drift);
    expect(signal.detected).toBe(true);
    expect(signal.reason.startsWith(`12 edits to "${TARGET}"`)).toBe(true);
    expect(signal.reason).toContain("you are thrashing");
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
    expect(signal.reason).toContain(`4 edits to "${TARGET}"`);
    expect(signal.reason).toContain("stop making many small edits");
  });
});

describe("detectDrift - workaround escalation fingerprints", () => {
  it("allows a corrected find command after prior destructive-flag denials", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "find /home/tim/.agent-framework/sessions -name '*.jsonl' -exec grep -H foo {} \\;",
        "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)",
      ),
      deniedBash(
        "find /home/tim/.agent-framework/sessions -type f -exec rg foo {} \\;",
        "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)",
      ),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "find /home/tim/.agent-framework/sessions -type f -name '*.jsonl' -print" },
      log,
      {},
    );

    expect(signal.detected).toBe(false);
  });

  it("denies a third retry that keeps the same find destructive flag", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "find /home/tim/.agent-framework/sessions -name '*.jsonl' -exec grep -H foo {} \\;",
        "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)",
      ),
      deniedBash(
        "find /home/tim/.agent-framework/sessions -type f -exec rg foo {} \\;",
        "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)",
      ),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "find /home/tim/.agent-framework/sessions -type f -exec rg bar {} \\;" },
      log,
      {},
    );

    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain("find:exec");
    expect(signal.reason).toContain("possible workaround escalation");
  });

  it("ignores generic shell tokens shared with prior denials", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "cd /home/tim/Coding/nixos/files/ags && npx tsc --noEmit 2>&1 | grep -E \"session-lock|utils/timers\" | head -30",
        "Filter restricting check output to AI's own changes",
      ),
      deniedBash(
        "cd /home/tim/Coding/nixos/files/ags && git diff --name-only HEAD 2>&1 && npx tsc --noEmit 2>&1 | head -50",
        "Filter restricting check output to AI's own changes",
      ),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "ls -la /home/tim/Coding/nixos/files/ags/src/bindings/ 2>&1; echo \"---\"; ls /home/tim/Coding/private_repos/astral/bindings/ 2>&1" },
      log,
      {},
    );

    expect(signal.detected).toBe(false);
  });

  it("denies a repeated check-output filtering pattern", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "cd /home/tim/Coding/nixos/files/ags && npx tsc --noEmit 2>&1 | grep -E \"session-lock|utils/timers\" | head -30",
        "Filter restricting check output to AI's own changes",
      ),
      deniedBash(
        "cd /home/tim/Coding/nixos/files/ags && git diff --name-only HEAD 2>&1 && npx tsc --noEmit 2>&1 | head -50",
        "Filter restricting check output to AI's own changes",
      ),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "npx tsc --noEmit 2>&1 | grep -E \"session-lock\" | head -50" },
      log,
      {},
    );

    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain("check-output-filter");
  });
});
