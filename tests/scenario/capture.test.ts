import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendCapture, loadCapturePointer } from "../../src/scenario/capture.js";
import type { CapturePointer } from "../../src/scenario/capture.js";

describe("capture", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-capture-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appendCapture writes a JSONL line and loadCapturePointer reads it back", () => {
    const pointer: Omit<CapturePointer, "seq"> = {
      ts: 1234567890,
      epoch_id: "epoch-abc",
      parent_capture_seq: null,
      event: "PreToolUse",
      tool_use_id: "toolu_test_1",
      decision: "allow",
      state_snapshot_seq: 1,
    };

    appendCapture(tmpDir, pointer);

    const loaded = loadCapturePointer(tmpDir, 1);
    expect(loaded).not.toBeNull();
    expect(loaded!.seq).toBe(1);
    expect(loaded!.epoch_id).toBe("epoch-abc");
    expect(loaded!.event).toBe("PreToolUse");
    expect(loaded!.decision).toBe("allow");
    expect(loaded!.tool_use_id).toBe("toolu_test_1");
    expect(loaded!.state_snapshot_seq).toBe(1);
  });

  it("auto-increments seq on each append", () => {
    const base: Omit<CapturePointer, "seq"> = {
      ts: Date.now(),
      epoch_id: "e1",
      parent_capture_seq: null,
      event: "PostToolUse",
      decision: "ok",
      state_snapshot_seq: null,
    };

    appendCapture(tmpDir, base);
    appendCapture(tmpDir, { ...base, event: "Stop", decision: "pass" });
    appendCapture(tmpDir, { ...base, event: "UserPromptSubmit", decision: "ok" });

    const p1 = loadCapturePointer(tmpDir, 1);
    const p2 = loadCapturePointer(tmpDir, 2);
    const p3 = loadCapturePointer(tmpDir, 3);

    expect(p1?.event).toBe("PostToolUse");
    expect(p2?.event).toBe("Stop");
    expect(p3?.event).toBe("UserPromptSubmit");
  });

  it("returns null when seq is not found", () => {
    const result = loadCapturePointer(tmpDir, 999);
    expect(result).toBeNull();
  });

  it("returns null when captures file does not exist", () => {
    const result = loadCapturePointer(path.join(tmpDir, "nonexistent"), 1);
    expect(result).toBeNull();
  });

  it("skips syntactically valid malformed-shape records", () => {
    const capturesPath = path.join(tmpDir, "captures.jsonl");
    fs.writeFileSync(
      capturesPath,
      [
        "null",
        JSON.stringify("not an object"),
        JSON.stringify({
          seq: 2,
          ts: 123,
          epoch_id: "epoch-abc",
          parent_capture_seq: null,
          event: "Stop",
          decision: "pass",
          state_snapshot_seq: null,
        }),
      ].join("\n") + "\n",
    );

    expect(loadCapturePointer(tmpDir, 1)).toBeNull();
    expect(loadCapturePointer(tmpDir, 2)?.decision).toBe("pass");
  });

  it("is a no-op when AGENT_FRAMEWORK_CAPTURE_CAP=0", () => {
    const origCap = process.env.AGENT_FRAMEWORK_CAPTURE_CAP;
    process.env.AGENT_FRAMEWORK_CAPTURE_CAP = "0";
    try {
      appendCapture(tmpDir, {
        ts: Date.now(),
        epoch_id: "e1",
        parent_capture_seq: null,
        event: "Stop",
        decision: "pass",
        state_snapshot_seq: null,
      });
      const capturesPath = path.join(tmpDir, "captures.jsonl");
      expect(fs.existsSync(capturesPath)).toBe(false);
    } finally {
      if (origCap === undefined) {
        delete process.env.AGENT_FRAMEWORK_CAPTURE_CAP;
      } else {
        process.env.AGENT_FRAMEWORK_CAPTURE_CAP = origCap;
      }
    }
  });
});
