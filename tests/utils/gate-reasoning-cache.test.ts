import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  extractGateNote,
  initGateReasoningSession,
  addEntry,
  getRecentEntries,
  getCondensedHistory,
  formatForPrompt,
  addPatternWarnings,
  updateAppealOutcome,
  type GateReasoningEntry,
} from "../../src/utils/gate-reasoning-cache.js";

describe("extractGateNote", () => {
  it("returns undefined when no NOTE line present", () => {
    expect(extractGateNote("APPROVE")).toBeUndefined();
  });

  it("extracts text after 'NOTE: ' on its own line", () => {
    expect(extractGateNote("APPROVE\nNOTE: User approved this path")).toBe("User approved this path");
  });

  it("trims extracted note text", () => {
    expect(extractGateNote("NOTE:   spaced out  ")).toBe("spaced out");
  });

  it("handles NOTE as first line", () => {
    expect(extractGateNote("NOTE: first line note")).toBe("first line note");
  });

  it("handles NOTE after other content", () => {
    const output = "DENY: not allowed\nSome explanation\nNOTE: important detail";
    expect(extractGateNote(output)).toBe("important detail");
  });

  it("returns only first NOTE match", () => {
    const output = "NOTE: first\nNOTE: second";
    expect(extractGateNote(output)).toBe("first");
  });

  it("handles NOTE: with only whitespace after it", () => {
    const result = extractGateNote("NOTE: ");
    // \s* is greedy but .+ needs at least one char - the trailing space is captured
    // then .trim() produces empty string
    expect(result).toBe("");
  });
});

// Phase 3: Eviction and formatting tests (I/O-dependent)
describe("gate-reasoning-cache eviction and formatting", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
    initGateReasoningSession(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function makeEntry(overrides: Partial<GateReasoningEntry> = {}): GateReasoningEntry {
    return {
      toolCallIndex: 1,
      timestamp: Date.now(),
      toolName: "Bash",
      toolTarget: "/tmp/test",
      decision: "ALLOWED",
      warnings: [],
      priority: "normal",
      ...overrides,
    };
  }

  it("stores and retrieves entries", async () => {
    await addEntry(tempDir, makeEntry({ toolCallIndex: 1 }));
    await addEntry(tempDir, makeEntry({ toolCallIndex: 2 }));
    const entries = await getRecentEntries(tempDir);
    expect(entries).toHaveLength(2);
  });

  it("evicts oldest normal-priority entries when exceeding limit (8)", async () => {
    for (let i = 0; i < 10; i++) {
      await addEntry(tempDir, makeEntry({ toolCallIndex: i, priority: "normal" }));
    }
    const entries = await getRecentEntries(tempDir, 20);
    const normalEntries = entries.filter((e) => e.priority === "normal");
    expect(normalEntries).toHaveLength(8);
    // Oldest (index 0, 1) should be evicted
    expect(normalEntries[0].toolCallIndex).toBe(2);
  });

  it("evicts oldest high-priority entries when exceeding limit (12)", async () => {
    for (let i = 0; i < 14; i++) {
      await addEntry(tempDir, makeEntry({ toolCallIndex: i, priority: "high", note: `note-${i}` }));
    }
    const entries = await getRecentEntries(tempDir, 20);
    const highEntries = entries.filter((e) => e.priority === "high");
    expect(highEntries).toHaveLength(12);
  });

  it("condensed history captures evicted high-priority entry notes", async () => {
    for (let i = 0; i < 14; i++) {
      await addEntry(tempDir, makeEntry({
        toolCallIndex: i,
        priority: "high",
        note: `important-${i}`,
        warnings: [`warning-${i}`],
      }));
    }
    const condensed = await getCondensedHistory(tempDir);
    expect(condensed).toContain("important-0");
    expect(condensed).toContain("warning-0");
  });

  it("truncates condensed history at 500 chars", async () => {
    // Add many high-priority entries with long notes to exceed 500 chars
    for (let i = 0; i < 20; i++) {
      await addEntry(tempDir, makeEntry({
        toolCallIndex: i,
        priority: "high",
        note: "a".repeat(50) + `-${i}`,
        warnings: ["b".repeat(50)],
      }));
    }
    const condensed = await getCondensedHistory(tempDir);
    expect(condensed.length).toBeLessThanOrEqual(500);
    expect(condensed.endsWith("...")).toBe(true);
  });

  it("keeps normal and high priority entries independent", async () => {
    for (let i = 0; i < 5; i++) {
      await addEntry(tempDir, makeEntry({ toolCallIndex: i, priority: "normal" }));
    }
    for (let i = 10; i < 15; i++) {
      await addEntry(tempDir, makeEntry({ toolCallIndex: i, priority: "high" }));
    }
    const entries = await getRecentEntries(tempDir, 20);
    expect(entries.filter((e) => e.priority === "normal")).toHaveLength(5);
    expect(entries.filter((e) => e.priority === "high")).toHaveLength(5);
  });

  describe("formatForPrompt", () => {
    it("returns empty string when no entries", async () => {
      expect(await formatForPrompt(tempDir)).toBe("");
    });

    it("formats recent entries with tool index and decision", async () => {
      await addEntry(tempDir, makeEntry({ toolCallIndex: 5, decision: "ALLOWED", toolName: "Edit", toolTarget: "/src/file.ts" }));
      const formatted = await formatForPrompt(tempDir);
      expect(formatted).toContain("[tool-5]");
      expect(formatted).toContain("ALLOWED");
      expect(formatted).toContain("Edit");
      expect(formatted).toContain("/src/file.ts");
    });

    it("includes notes, warnings, and appeal outcomes", async () => {
      await addEntry(tempDir, makeEntry({
        toolCallIndex: 1,
        note: "test note",
        warnings: ["warn1"],
      }));
      await updateAppealOutcome(tempDir, 1, "OVERTURNED");
      const formatted = await formatForPrompt(tempDir);
      expect(formatted).toContain("NOTE: test note");
      expect(formatted).toContain("warn1");
      expect(formatted).toContain("APPEAL: OVERTURNED");
    });
  });

  describe("addPatternWarnings", () => {
    it("returns git warning when 2+ git commands in log", async () => {
      // Write tool-log.jsonl with git commands
      const logPath = path.join(tempDir, "tool-log.jsonl");
      const entries = [
        { tool_name: "Bash", tool_input: { command: "git status" } },
        { tool_name: "Bash", tool_input: { command: "git diff" } },
      ];
      fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const warnings = await addPatternWarnings("Bash", { command: "git log" }, tempDir);
      expect(warnings.some((w) => w.includes("git commands"))).toBe(true);
    });

    it("returns repeated edit warning for 3+ edits to same file", async () => {
      const logPath = path.join(tempDir, "tool-log.jsonl");
      const entries = [
        { tool_name: "Edit", tool_input: { file_path: "/src/main.ts" } },
        { tool_name: "Edit", tool_input: { file_path: "/src/main.ts" } },
        { tool_name: "Edit", tool_input: { file_path: "/src/main.ts" } },
      ];
      fs.writeFileSync(logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

      const warnings = await addPatternWarnings("Edit", { file_path: "/src/main.ts" }, tempDir);
      expect(warnings.some((w) => w.includes("Multiple edits"))).toBe(true);
    });

    it("does not turn repeated denials into a pattern warning", async () => {
      await addEntry(tempDir, makeEntry({
        toolCallIndex: 1,
        decision: "DENIED",
        toolTarget: "/src/main.ts",
      }));
      await addEntry(tempDir, makeEntry({
        toolCallIndex: 2,
        decision: "DENIED",
        toolTarget: "/src/main.ts",
      }));
      fs.writeFileSync(path.join(tempDir, "tool-log.jsonl"), "");

      const warnings = await addPatternWarnings("Edit", { file_path: "/src/main.ts" }, tempDir);
      expect(warnings.some((w) => w.includes("denials"))).toBe(false);
    });
  });
});
