import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { isPlanModeActive, isPlanModeFromInput } from "../../src/utils/plan-mode-detector.js";

describe("isPlanModeFromInput", () => {
  it("returns true when permission_mode is 'plan'", () => {
    expect(isPlanModeFromInput({ permission_mode: "plan" })).toBe(true);
  });

  it("returns false for 'default'", () => {
    expect(isPlanModeFromInput({ permission_mode: "default" })).toBe(false);
  });

  it("returns false for 'acceptEdits'", () => {
    expect(isPlanModeFromInput({ permission_mode: "acceptEdits" })).toBe(false);
  });

  it("returns false for 'bypassPermissions'", () => {
    expect(isPlanModeFromInput({ permission_mode: "bypassPermissions" })).toBe(false);
  });

  it("returns false when permission_mode is undefined", () => {
    expect(isPlanModeFromInput({})).toBe(false);
  });
});

describe("isPlanModeActive (transcript fallback)", () => {
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

  it("returns false when no permissionMode marker exists", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", name: "Read", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(false);
  });

  it("returns true when latest permission-mode event is 'plan'", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "user", permissionMode: "default" }) + "\n" +
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(true);
  });

  it("returns false when latest permission-mode event is 'default'", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }) + "\n" +
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(false);
  });

  it("uses per-message permissionMode field as a marker", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "user", permissionMode: "plan", message: "hi" }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(true);
  });

  it("takes the most recent marker (last one wins)", () => {
    const lines = [
      JSON.stringify({ type: "permission-mode", permissionMode: "plan" }),
      JSON.stringify({ type: "user", permissionMode: "plan" }),
      JSON.stringify({ type: "permission-mode", permissionMode: "default" }),
      JSON.stringify({ type: "user", permissionMode: "default" }),
    ];
    const filePath = writeTranscript(lines.join("\n") + "\n");
    expect(isPlanModeActive(filePath)).toBe(false);
  });

  it("ignores EnterPlanMode/ExitPlanMode tool_use entries (not plan-mode signals)", () => {
    const filePath = writeTranscript(
      JSON.stringify({ type: "tool_use", name: "EnterPlanMode", input: {} }) + "\n"
    );
    expect(isPlanModeActive(filePath)).toBe(false);
  });
});
