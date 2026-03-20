import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPlanModeActive } from "../../src/utils/plan-mode-detector.js";

describe("isPlanModeActive", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTranscript(content: string): string {
    const filePath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("returns false for non-existent file", () => {
    expect(isPlanModeActive(path.join(tempDir, "missing.jsonl"))).toBe(false);
  });

  it("returns false when EnterPlanMode never appears", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", name: "Read", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(false);
  });

  it("returns true when EnterPlanMode appears without ExitPlanMode", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", name: "Read" }) + "\n" +
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(true);
  });

  it("returns false when ExitPlanMode appears after EnterPlanMode", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode", input: {} }) + "\n" +
      JSON.stringify({ type: "tool_use", "name":"ExitPlanMode", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(false);
  });

  it("returns true when EnterPlanMode appears after ExitPlanMode (re-entered)", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode", input: {} }) + "\n" +
      JSON.stringify({ type: "tool_use", "name":"ExitPlanMode", input: {} }) + "\n" +
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(true);
  });

  it("handles multiple transitions (last one wins)", () => {
    const lines = [
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode" }),
      JSON.stringify({ type: "tool_use", "name":"ExitPlanMode" }),
      JSON.stringify({ type: "tool_use", "name":"EnterPlanMode" }),
      JSON.stringify({ type: "tool_use", "name":"ExitPlanMode" }),
    ];
    const filePath = writeTranscript(lines.join("\n") + "\n");
    expect(isPlanModeActive(filePath)).toBe(false);
  });
});
