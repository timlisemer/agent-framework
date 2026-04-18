import { describe, it, expect } from "vitest";
import {
  isEditTool,
  isEditIntentExemptPath,
  shouldBlockEdit,
  planModeEditBlock,
  planModeBashBlock,
  deriveEditIntentFromPrediction,
} from "../../src/utils/edit-intent.js";
import type { ToolPrediction } from "../../src/utils/prediction-types.js";

describe("isEditTool", () => {
  it("returns true for 'Edit'", () => {
    expect(isEditTool("Edit")).toBe(true);
  });

  it("returns true for 'Write'", () => {
    expect(isEditTool("Write")).toBe(true);
  });

  it("returns true for 'NotebookEdit'", () => {
    expect(isEditTool("NotebookEdit")).toBe(true);
  });

  it("returns false for 'Read'", () => {
    expect(isEditTool("Read")).toBe(false);
  });

  it("returns false for 'Bash'", () => {
    expect(isEditTool("Bash")).toBe(false);
  });

  it("returns false for 'Grep'", () => {
    expect(isEditTool("Grep")).toBe(false);
  });
});

describe("isEditIntentExemptPath", () => {
  it("returns true for plan files", () => {
    expect(isEditIntentExemptPath("/home/user/.claude/plans/my-plan.md")).toBe(true);
  });

  it("returns true for memory files", () => {
    expect(isEditIntentExemptPath("/home/user/.claude/projects/-foo/memory/bar.md")).toBe(true);
  });

  it("returns true for MEMORY.md", () => {
    expect(isEditIntentExemptPath("/home/user/.claude/projects/-foo/memory/MEMORY.md")).toBe(true);
  });

  it("returns true for CLAUDE.md", () => {
    expect(isEditIntentExemptPath("/home/user/project/CLAUDE.md")).toBe(true);
  });

  it("returns false for regular source files", () => {
    expect(isEditIntentExemptPath("/home/user/project/src/main.ts")).toBe(false);
  });

  it("returns false for README.md", () => {
    expect(isEditIntentExemptPath("/home/user/project/README.md")).toBe(false);
  });
});

describe("shouldBlockEdit", () => {
  it("blocks Edit on project file when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Edit", "/home/user/project/src/main.ts")).toBe(true);
  });

  it("blocks Write on project file when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Write", "/home/user/project/src/main.ts")).toBe(true);
  });

  it("blocks NotebookEdit on project file when editIntent is false", () => {
    expect(shouldBlockEdit(false, "NotebookEdit", "/home/user/project/notebook.ipynb")).toBe(true);
  });

  it("does not block Edit when editIntent is true", () => {
    expect(shouldBlockEdit(true, "Edit", "/home/user/project/src/main.ts")).toBe(false);
  });

  it("does not block Edit when editIntent is null (fail-open)", () => {
    expect(shouldBlockEdit(null, "Edit", "/home/user/project/src/main.ts")).toBe(false);
  });

  it("does not block Read when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Read", "/home/user/project/src/main.ts")).toBe(false);
  });

  it("does not block Edit on plan files when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Edit", "/home/user/.claude/plans/my-plan.md")).toBe(false);
  });

  it("does not block Edit on memory files when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Edit", "/home/user/.claude/projects/-foo/memory/bar.md")).toBe(false);
  });

  it("does not block Edit on CLAUDE.md when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Edit", "/home/user/project/CLAUDE.md")).toBe(false);
  });

  it("does not block Bash when editIntent is false", () => {
    expect(shouldBlockEdit(false, "Bash", "/some/path")).toBe(false);
  });
});

describe("planModeEditBlock", () => {
  it("blocks Edit to non-exempt path when plan mode active", () => {
    const result = planModeEditBlock(true, "Edit", "/project/src/foo.ts");
    expect(result).toContain("Plan mode is active");
  });

  it("blocks Write to non-exempt path when plan mode active", () => {
    const result = planModeEditBlock(true, "Write", "/project/src/foo.ts");
    expect(result).toContain("Plan mode is active");
  });

  it("blocks NotebookEdit to non-exempt path when plan mode active", () => {
    const result = planModeEditBlock(true, "NotebookEdit", "/project/notebook.ipynb");
    expect(result).toContain("Plan mode is active");
  });

  it("allows Edit to plan file when plan mode active", () => {
    expect(planModeEditBlock(true, "Edit", "/home/user/.claude/plans/my-plan.md")).toBeNull();
  });

  it("allows Edit to memory file when plan mode active", () => {
    expect(planModeEditBlock(true, "Edit", "/home/user/.claude/projects/-foo/memory/bar.md")).toBeNull();
  });

  it("allows Edit to CLAUDE.md when plan mode active", () => {
    expect(planModeEditBlock(true, "Edit", "/project/CLAUDE.md")).toBeNull();
  });

  it("allows Read in plan mode", () => {
    expect(planModeEditBlock(true, "Read", "/project/src/foo.ts")).toBeNull();
  });

  it("returns null when plan mode inactive", () => {
    expect(planModeEditBlock(false, "Edit", "/project/src/foo.ts")).toBeNull();
  });
});

describe("planModeBashBlock", () => {
  it("blocks echo redirect in plan mode", () => {
    const result = planModeBashBlock(true, "Bash", 'echo "test" > file.txt');
    expect(result).toContain("Plan mode is active");
  });

  it("blocks git commit in plan mode", () => {
    const result = planModeBashBlock(true, "Bash", "git commit -m 'msg'");
    expect(result).toContain("Plan mode is active");
  });

  it("blocks git push in plan mode", () => {
    const result = planModeBashBlock(true, "Bash", "git push origin main");
    expect(result).toContain("Plan mode is active");
  });

  it("blocks rm in plan mode", () => {
    const result = planModeBashBlock(true, "Bash", "rm -rf dist/");
    expect(result).toContain("Plan mode is active");
  });

  it("blocks sed -i in plan mode", () => {
    const result = planModeBashBlock(true, "Bash", "sed -i 's/foo/bar/' file.txt");
    expect(result).toContain("Plan mode is active");
  });

  it("allows git status in plan mode", () => {
    expect(planModeBashBlock(true, "Bash", "git status")).toBeNull();
  });

  it("allows git log in plan mode", () => {
    expect(planModeBashBlock(true, "Bash", "git log --oneline -10")).toBeNull();
  });

  it("allows ls in plan mode", () => {
    expect(planModeBashBlock(true, "Bash", "ls -la src/")).toBeNull();
  });

  it("returns null when plan mode inactive", () => {
    expect(planModeBashBlock(false, "Bash", "rm -rf dist/")).toBeNull();
  });

  it("returns null for non-Bash tools", () => {
    expect(planModeBashBlock(true, "Edit", "anything")).toBeNull();
  });
});

function makePrediction(overrides: Partial<ToolPrediction> = {}): ToolPrediction {
  return {
    mood: "neutral",
    trust: "normal",
    intent: "",
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    userMessageSnippet: "",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("deriveEditIntentFromPrediction", () => {
  it("returns false when blockAllTools is true (priority 1)", () => {
    const p = makePrediction({
      blockAllTools: true,
      intent: "fix the bug",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(false);
  });

  it("returns true when explicitlyAllowedTools contains an edit tool (priority 2)", () => {
    const p = makePrediction({
      explicitlyAllowedTools: ["Edit"],
      intent: "just read the files",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(true);
  });

  it("returns false when explicitlyBlockedSubstrings targets an edit tool (priority 3)", () => {
    const p = makePrediction({
      explicitlyBlockedSubstrings: [{ tool: "Edit", reason: "no edits" }],
      intent: "fix the bug",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(false);
  });

  it("returns false when blockedIntent contains read-only verb (priority 4)", () => {
    const p = makePrediction({
      blockedIntent: "just explore the code",
      intent: "look at auth",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(false);
  });

  it("returns true when intent contains implementation verb (priority 5)", () => {
    const p = makePrediction({
      intent: "refactor the auth module",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(true);
  });

  it("returns false when intent contains read-only verb (priority 6)", () => {
    const p = makePrediction({
      intent: "explain how auth works",
    });
    expect(deriveEditIntentFromPrediction(p)).toBe(false);
  });

  it("returns null when no branch matches (priority 7)", () => {
    const p = makePrediction({
      intent: "hmm interesting",
    });
    expect(deriveEditIntentFromPrediction(p)).toBeNull();
  });
});
