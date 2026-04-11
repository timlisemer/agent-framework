import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  isSubagent,
  detectSubagent,
  getActiveSubagentCount,
  incrementActiveSubagents,
  decrementActiveSubagents,
} from "../../src/utils/subagent-detector.js";

vi.mock("../../src/utils/cache-manager.js", () => ({
  getSessionDir: vi.fn(),
}));

import { getSessionDir } from "../../src/utils/cache-manager.js";
const mockGetSessionDir = vi.mocked(getSessionDir);

describe("isSubagent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
    mockGetSessionDir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeTranscript(filename: string, lines: string[]): string {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  it("returns true for filename starting with 'agent-' and ending '.jsonl'", () => {
    const filePath = writeTranscript("agent-abc123.jsonl", ["{}"]);
    expect(isSubagent(filePath)).toBe(true);
  });

  it("returns false for regular transcript filename", () => {
    const filePath = writeTranscript("session-abc123.jsonl", [
      JSON.stringify({ cwd: "/tmp", model: "claude" }),
    ]);
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns true when metadata has isSidechain=true and agentId", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ isSidechain: true, agentId: "a792db3" }),
    ]);
    expect(isSubagent(filePath)).toBe(true);
  });

  it("returns false when metadata has isSidechain=true but no agentId", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ isSidechain: true }),
    ]);
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns true for content-based detection (type=summary containing 'agent')", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ some: "data" }),
      JSON.stringify({ type: "summary", summary: "This is an agent task" }),
    ]);
    expect(isSubagent(filePath)).toBe(true);
  });

  it("returns false for main session (has cwd and model, no isSidechain)", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ cwd: "/home/user/project", model: "claude-3" }),
    ]);
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns false for empty file", () => {
    const filePath = path.join(tempDir, "session-empty.jsonl");
    fs.writeFileSync(filePath, "");
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns false for non-existent file", () => {
    const filePath = path.join(tempDir, "does-not-exist.jsonl");
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns false for file with invalid JSON on first line", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      "not json at all",
      "also not json",
    ]);
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns false when isSidechain is false", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ isSidechain: false, agentId: "abc" }),
    ]);
    expect(isSubagent(filePath)).toBe(false);
  });

  it("returns true when path contains /subagents/ directory", () => {
    const subagentsDir = path.join(tempDir, "subagents");
    fs.mkdirSync(subagentsDir);
    const filePath = path.join(subagentsDir, "some-uuid.jsonl");
    fs.writeFileSync(filePath, "{}");
    expect(isSubagent(filePath)).toBe(true);
  });
});

describe("detectSubagent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-detect-"));
    mockGetSessionDir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeTranscript(filename: string, lines: string[]): string {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  it("returns method 'filename' for agent-*.jsonl", () => {
    const filePath = writeTranscript("agent-abc123.jsonl", ["{}"]);
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "filename", activeSubagentCount: 0 });
  });

  it("returns method 'path-segment' for /subagents/ path", () => {
    const subagentsDir = path.join(tempDir, "subagents");
    fs.mkdirSync(subagentsDir);
    const filePath = path.join(subagentsDir, "some-uuid.jsonl");
    fs.writeFileSync(filePath, "{}");
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "path-segment", activeSubagentCount: 0 });
  });

  it("returns method 'metadata' for isSidechain + agentId", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ isSidechain: true, agentId: "a792db3" }),
    ]);
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "metadata", activeSubagentCount: 0 });
  });

  it("returns method 'content' for summary containing 'agent'", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ some: "data" }),
      JSON.stringify({ type: "summary", summary: "This is an agent task" }),
    ]);
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "content", activeSubagentCount: 0 });
  });

  it("returns method 'none' for main session with no active subagents", () => {
    const filePath = writeTranscript("session-test.jsonl", [
      JSON.stringify({ cwd: "/home/user/project", model: "claude-3" }),
    ]);
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: false, method: "none", activeSubagentCount: 0 });
  });
});

describe("counter fallback", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-counter-fb-"));
    mockGetSessionDir.mockReturnValue(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeTranscript(filename: string, lines: string[]): string {
    const filePath = path.join(tempDir, filename);
    fs.writeFileSync(filePath, lines.join("\n") + "\n");
    return filePath;
  }

  it("does not treat confirmed main session as subagent even with active counter", () => {
    const filePath = writeTranscript("session-parent.jsonl", [
      JSON.stringify({ cwd: "/home/user/project", model: "claude-3" }),
    ]);
    // Simulate subagent-start having incremented the counter
    incrementActiveSubagents(tempDir);
    incrementActiveSubagents(tempDir);

    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: false, method: "none", activeSubagentCount: 0 });
  });

  it("returns false when counter is 0", () => {
    const filePath = writeTranscript("session-parent.jsonl", [
      JSON.stringify({ cwd: "/home/user/project", model: "claude-3" }),
    ]);
    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: false, method: "none", activeSubagentCount: 0 });
  });

  it("returns false when counter has dead parent PID (staleness)", () => {
    const filePath = writeTranscript("session-parent-stale.jsonl", [
      JSON.stringify({ some: "data" }),
    ]);
    // Write a counter with a PID that doesn't exist
    const counterPath = path.join(tempDir, "active-subagents.json");
    fs.writeFileSync(counterPath, JSON.stringify({ count: 1, pid: 999999 }));

    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: false, method: "none", activeSubagentCount: 0 });
  });

  it("detects via counter for empty transcript file with active subagents", () => {
    const filePath = path.join(tempDir, "session-empty.jsonl");
    fs.writeFileSync(filePath, "");
    incrementActiveSubagents(tempDir);

    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "counter-fallback", activeSubagentCount: 1 });
  });

  it("detects via counter for non-existent transcript with active subagents", () => {
    const filePath = path.join(tempDir, "does-not-exist.jsonl");
    incrementActiveSubagents(tempDir);

    const result = detectSubagent(filePath);
    expect(result).toEqual({ isSubagent: true, method: "counter-fallback", activeSubagentCount: 1 });
  });
});

describe("active subagent counter", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-counter-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns 0 when no file exists", () => {
    expect(getActiveSubagentCount(tempDir)).toBe(0);
  });

  it("returns correct count after increment", () => {
    incrementActiveSubagents(tempDir);
    expect(getActiveSubagentCount(tempDir)).toBe(1);
  });

  it("increments multiple times", () => {
    incrementActiveSubagents(tempDir);
    incrementActiveSubagents(tempDir);
    incrementActiveSubagents(tempDir);
    expect(getActiveSubagentCount(tempDir)).toBe(3);
  });

  it("decrements correctly", () => {
    incrementActiveSubagents(tempDir);
    incrementActiveSubagents(tempDir);
    decrementActiveSubagents(tempDir);
    expect(getActiveSubagentCount(tempDir)).toBe(1);
  });

  it("does not go below 0 on decrement", () => {
    decrementActiveSubagents(tempDir);
    expect(getActiveSubagentCount(tempDir)).toBe(0);
  });

  it("returns 0 when parent PID is dead (staleness)", () => {
    const filePath = path.join(tempDir, "active-subagents.json");
    fs.writeFileSync(filePath, JSON.stringify({ count: 2, pid: 999999 }));
    expect(getActiveSubagentCount(tempDir)).toBe(0);
  });
});
