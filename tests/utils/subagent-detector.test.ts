import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isSubagent } from "../../src/utils/subagent-detector.js";

describe("isSubagent", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
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
});
