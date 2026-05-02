import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectEpochChange, rotateEpoch, loadCurrentEpoch } from "../../src/scenario/epoch.js";

describe("epoch", () => {
  let tmpDir: string;
  let transcriptPath: string;
  const ORIG_SESSION_DIR = process.env.AGENT_FRAMEWORK_SESSION_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-epoch-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
    // Ensure we're not in replay context
    delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ORIG_SESSION_DIR !== undefined) {
      process.env.AGENT_FRAMEWORK_SESSION_DIR = ORIG_SESSION_DIR;
    } else {
      delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
    }
  });

  it("detectEpochChange returns rotated:false on a fresh session (no snapshots)", () => {
    // No state-snapshots.jsonl and no transcript
    fs.writeFileSync(transcriptPath, "");
    const result = detectEpochChange(tmpDir, transcriptPath);
    expect(result.rotated).toBe(false);
  });

  it("detectEpochChange returns rotated:false when replay context is set", () => {
    process.env.AGENT_FRAMEWORK_SESSION_DIR = tmpDir;
    const result = detectEpochChange(tmpDir, transcriptPath);
    expect(result.rotated).toBe(false);
  });

  it("detectEpochChange returns rotated:true with reason:compact on compact hint", () => {
    fs.writeFileSync(transcriptPath, "");
    const result = detectEpochChange(tmpDir, transcriptPath, {
      sessionStartSource: "compact",
    });
    expect(result.rotated).toBe(true);
    expect(result.reason).toBe("compact");
    expect(result.anchorUuid).toBeNull();
  });

  it("rotateEpoch writes an epoch record with correct shape", () => {
    const epoch = rotateEpoch(tmpDir, "rewind", "uuid-anchor-123");
    expect(epoch.id).toBeTruthy();
    expect(epoch.reason).toBe("rewind");
    expect(epoch.anchor_uuid).toBe("uuid-anchor-123");
    expect(epoch.parent_epoch_id).toBeNull();
    expect(epoch.adapter).toBe("claude");

    const loaded = loadCurrentEpoch(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(epoch.id);
  });

  it("rotateEpoch sets parent_epoch_id on subsequent rotations", () => {
    const first = rotateEpoch(tmpDir, "initial", null);
    const second = rotateEpoch(tmpDir, "compact", null);
    expect(second.parent_epoch_id).toBe(first.id);
  });

  it("loadCurrentEpoch returns null when no epochs file exists", () => {
    const result = loadCurrentEpoch(tmpDir);
    expect(result).toBeNull();
  });
});
