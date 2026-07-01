import { describe, it, expect } from "vitest";
import { detectDrift } from "../../src/utils/drift-detector.js";
import { FIND_DESTRUCTIVE_DENY_REASON } from "../../src/utils/find-command-policy.js";
import type { DriftTargetState, ToolLogEntry } from "../../src/utils/session-store.js";

const TARGET = "/home/tim/.claude/plans/drift.md";

function allowedEdit(path: string = TARGET): ToolLogEntry {
  return { ts: 0, tool: "Edit", path, status: "allowed", gate: "edit-intent", ms: 0 };
}

function deniedBash(command: string, reason: string): ToolLogEntry {
  return { ts: 0, tool: "Bash", cmd: command, status: "denied", gate: "tool-approve", reason, ms: 0 };
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

  it("works without a driftState argument (backward compatible)", () => {
    const log: ToolLogEntry[] = Array.from({ length: 5 }, () => allowedEdit());
    const signal = detectDrift("Edit", { file_path: TARGET }, log);
    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain(`5 edits to "${TARGET}"`);
    expect(signal.reason).toContain("stop making many small edits");
  });
});

describe("detectDrift - workaround escalation fingerprints", () => {
  it("allows a corrected find command after prior destructive-flag denials", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "find /home/tim/.agent-framework/sessions -name '*.jsonl' -exec grep -H foo {} \\;",
        FIND_DESTRUCTIVE_DENY_REASON,
      ),
      deniedBash(
        "find /home/tim/.agent-framework/sessions -type f -exec rg foo {} \\;",
        FIND_DESTRUCTIVE_DENY_REASON,
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
        FIND_DESTRUCTIVE_DENY_REASON,
      ),
      deniedBash(
        "find /home/tim/.agent-framework/sessions -type f -exec rg foo {} \\;",
        FIND_DESTRUCTIVE_DENY_REASON,
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

  it("fingerprints fprintf with the shared destructive find flag list", () => {
    const log: ToolLogEntry[] = [
      deniedBash(
        "find /tmp -fprintf out.txt '%p\\n'",
        FIND_DESTRUCTIVE_DENY_REASON,
      ),
      deniedBash(
        "find /tmp -fprintf other.txt '%p\\n'",
        FIND_DESTRUCTIVE_DENY_REASON,
      ),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "find /tmp -fprintf third.txt '%p\\n'" },
      log,
      {},
    );

    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain("find:fprintf");
  });

  it("does not fingerprint destructive-looking find option values or literals", () => {
    const log: ToolLogEntry[] = [
      deniedBash("find /tmp -delete", FIND_DESTRUCTIVE_DENY_REASON),
      deniedBash("find /tmp -delete", FIND_DESTRUCTIVE_DENY_REASON),
    ];

    for (const command of [
      "find /tmp -name -delete",
      "find /tmp -printf -delete",
      "find /tmp -- -delete",
    ]) {
      const signal = detectDrift("Bash", { command }, log, {});
      expect(signal.detected, command).toBe(false);
    }
  });

  it("fingerprints nested destructive find payloads with shared traversal", () => {
    const cases = [
      {
        command: "bash -c 'find . -delete'",
        fingerprint: "find:delete",
      },
      {
        command: "eval 'find . -exec rm {} \\;'",
        fingerprint: "find:exec",
      },
      {
        command: "xargs -I{} find {} -delete",
        fingerprint: "find:delete",
      },
    ];

    for (const { command, fingerprint } of cases) {
      const log: ToolLogEntry[] = [
        deniedBash(command, FIND_DESTRUCTIVE_DENY_REASON),
        deniedBash(command, FIND_DESTRUCTIVE_DENY_REASON),
      ];
      const signal = detectDrift("Bash", { command }, log, {});
      expect(signal.detected, command).toBe(true);
      expect(signal.reason, command).toContain(fingerprint);
    }
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

  it("denies repeated denied file-write workarounds", () => {
    const log: ToolLogEntry[] = [
      deniedBash("printf x > /tmp/out.txt", "shell redirect to file"),
      deniedBash("dd if=/tmp/in of=/tmp/out.txt", "dd file write"),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "cp /tmp/in /tmp/out.txt" },
      log,
      {},
    );

    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain("bash:file-write");
  });

  it("denies repeated denied background file-write workarounds from the current command", () => {
    const log: ToolLogEntry[] = [
      deniedBash("bash -lc 'printf x > /tmp/out.txt' &", "background shell file write"),
      deniedBash("bash -lc 'dd if=/tmp/in of=/tmp/out.txt' &", "background shell file write"),
    ];

    const signal = detectDrift(
      "Bash",
      { command: "bash -lc 'cp /tmp/in /tmp/out.txt' &" },
      log,
      {},
    );

    expect(signal.detected).toBe(true);
    expect(signal.reason).toContain("bash:background-file-write");
  });
});
