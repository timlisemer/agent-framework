import { describe, it, expect } from "vitest";
import {
  detectEditSignal,
  parseEditIntentOutput,
  isEditTool,
  isEditIntentExemptPath,
  shouldBlockEdit,
  classifyEditIntent,
  planModeEditBlock,
  planModeBashBlock,
  STICKINESS_TIMEOUT_MS,
} from "../../src/utils/edit-intent.js";

describe("detectEditSignal", () => {
  describe("direct imperatives", () => {
    it("detects 'fix the bug' as edit", () => {
      expect(detectEditSignal("fix the bug", false)).toBe("edit");
    });

    it("detects 'refactor the module' as edit", () => {
      expect(detectEditSignal("refactor the module", false)).toBe("edit");
    });

    it("detects 'add endpoint' as edit", () => {
      expect(detectEditSignal("add endpoint", false)).toBe("edit");
    });
  });

  describe("polite requests", () => {
    it("detects 'can you fix this' as edit", () => {
      expect(detectEditSignal("can you fix this", false)).toBe("edit");
    });

    it("detects 'please update the config' as edit", () => {
      expect(detectEditSignal("please update the config", false)).toBe("edit");
    });
  });

  describe("informal requests", () => {
    it("detects 'let's refactor this' as edit", () => {
      expect(detectEditSignal("let's refactor this", false)).toBe("edit");
    });

    it("detects 'gonna need you to fix this' as edit", () => {
      expect(detectEditSignal("gonna need you to fix this", false)).toBe("edit");
    });
  });

  describe("error-driven requests", () => {
    it("detects 'it's broken' as edit", () => {
      expect(detectEditSignal("it's broken", false)).toBe("edit");
    });

    it("detects 'not working' as edit", () => {
      expect(detectEditSignal("not working", false)).toBe("edit");
    });
  });

  describe("file-targeted requests", () => {
    it("detects 'change something in src/auth.ts' as edit", () => {
      expect(detectEditSignal("change something in src/auth.ts", false)).toBe("edit");
    });
  });

  describe("plan transitions", () => {
    it("detects 'start implementing' as edit", () => {
      expect(detectEditSignal("start implementing", false)).toBe("edit");
    });
  });

  describe("continuation with previous edit intent", () => {
    it("detects 'ok' with prev=true as edit", () => {
      expect(detectEditSignal("ok", true)).toBe("edit");
    });

    it("detects 'yes' with prev=true as edit", () => {
      expect(detectEditSignal("yes", true)).toBe("edit");
    });

    it("detects 'go ahead' with prev=true as edit", () => {
      expect(detectEditSignal("go ahead", true)).toBe("edit");
    });
  });

  describe("continuation with no previous edit intent", () => {
    it("detects 'ok' with prev=false as ambiguous", () => {
      expect(detectEditSignal("ok", false)).toBe("ambiguous");
    });

    it("detects 'yes' with prev=false as ambiguous", () => {
      expect(detectEditSignal("yes", false)).toBe("ambiguous");
    });
  });

  describe("read verbs", () => {
    it("detects 'explain this code' as non-edit", () => {
      expect(detectEditSignal("explain this code", false)).toBe("non-edit");
    });

    it("detects 'show me the output' as non-edit", () => {
      expect(detectEditSignal("show me the output", false)).toBe("non-edit");
    });

    it("detects 'read the file' as non-edit", () => {
      expect(detectEditSignal("read the file", false)).toBe("non-edit");
    });
  });

  describe("negation", () => {
    it("detects 'don't edit anything' as non-edit", () => {
      expect(detectEditSignal("don't edit anything", false)).toBe("non-edit");
    });

    it("detects 'do not change the code' as non-edit", () => {
      expect(detectEditSignal("do not change the code", false)).toBe("non-edit");
    });
  });

  describe("questions", () => {
    it("detects 'what does this do?' as non-edit", () => {
      expect(detectEditSignal("what does this do?", false)).toBe("non-edit");
    });

    it("detects 'how does it work?' as non-edit", () => {
      expect(detectEditSignal("how does it work?", false)).toBe("non-edit");
    });
  });

  describe("explain dominates over fix", () => {
    it("detects 'explain how to fix' as non-edit", () => {
      expect(detectEditSignal("explain how to fix", false)).toBe("non-edit");
    });
  });

  describe("compound override", () => {
    it("detects 'review and fix' as edit", () => {
      expect(detectEditSignal("review and fix", false)).toBe("edit");
    });
  });

  describe("plan without implement", () => {
    it("detects 'plan how to implement this feature' as non-edit", () => {
      expect(detectEditSignal("plan how to implement this feature", false)).toBe("non-edit");
    });
  });

  describe("conversation enders", () => {
    it("detects 'thanks' as non-edit", () => {
      expect(detectEditSignal("thanks", false)).toBe("non-edit");
    });

    it("detects 'got it' as non-edit", () => {
      expect(detectEditSignal("got it", false)).toBe("non-edit");
    });

    it("detects 'never mind' as non-edit", () => {
      expect(detectEditSignal("never mind", false)).toBe("non-edit");
    });
  });

  describe("edge cases", () => {
    it("detects empty string as ambiguous", () => {
      expect(detectEditSignal("", false)).toBe("ambiguous");
    });

    it("detects 'What about the tests?' as non-edit", () => {
      expect(detectEditSignal("What about the tests?", false)).toBe("non-edit");
    });
  });
});

describe("parseEditIntentOutput", () => {
  it("parses 'EDIT' as true", () => {
    expect(parseEditIntentOutput("EDIT")).toBe(true);
  });

  it("parses 'NON-EDIT' as false", () => {
    expect(parseEditIntentOutput("NON-EDIT")).toBe(false);
  });

  it("parses 'EDIT - user wants changes' as true", () => {
    expect(parseEditIntentOutput("EDIT - user wants changes")).toBe(true);
  });

  it("parses lowercase 'non-edit' as false", () => {
    expect(parseEditIntentOutput("non-edit")).toBe(false);
  });

  it("parses empty string as null", () => {
    expect(parseEditIntentOutput("")).toBe(null);
  });

  it("parses 'maybe' as null", () => {
    expect(parseEditIntentOutput("maybe")).toBe(null);
  });
});

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

describe("classifyEditIntent", () => {
  const recentTimestamp = Date.now() - 1000; // 1 second ago
  const staleTimestamp = Date.now() - (STICKINESS_TIMEOUT_MS + 1000); // timed out

  it("returns false in plan mode", () => {
    expect(classifyEditIntent("fix the bug", true, recentTimestamp, true)).toBe(false);
  });

  it("returns true for clear edit signal", () => {
    expect(classifyEditIntent("fix the bug", null, 0, false)).toBe(true);
  });

  it("returns false for clear non-edit signal", () => {
    expect(classifyEditIntent("explain this code", null, 0, false)).toBe(false);
  });

  it("returns null for ambiguous signal", () => {
    expect(classifyEditIntent("hmm interesting", null, 0, false)).toBe(null);
  });

  it("maintains stickiness when previous was edit and not timed out", () => {
    expect(classifyEditIntent("also the tests", true, recentTimestamp, false)).toBe(true);
  });

  it("breaks stickiness on non-edit signal", () => {
    expect(classifyEditIntent("explain this code", true, recentTimestamp, false)).toBe(false);
  });

  it("does not apply stickiness when timed out", () => {
    // "hmm" with stale timestamp -> falls through to regex with prev=true, returns ambiguous -> null
    expect(classifyEditIntent("hmm interesting", true, staleTimestamp, false)).toBe(null);
  });
});

describe("STICKINESS_TIMEOUT_MS", () => {
  it("equals 600000", () => {
    expect(STICKINESS_TIMEOUT_MS).toBe(600000);
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
