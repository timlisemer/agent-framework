import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendCapture } from "../../src/scenario/capture.js";
import { appendStateSnapshot } from "../../src/scenario/snapshot.js";
import { rotateEpoch } from "../../src/scenario/epoch.js";
import { materializeScenario } from "../../src/scenario/materialize.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";

describe("materializeScenario", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-materialize-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");

    // Write a minimal two-line transcript with UUIDs.
    const userLine = JSON.stringify({
      uuid: "uuid-user-001",
      type: "user",
      message: { role: "user", content: "hello" },
      parentUuid: null,
    });
    const assistantLine = JSON.stringify({
      uuid: "uuid-asst-002",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "world" }],
      },
      parentUuid: "uuid-user-001",
    });
    fs.writeFileSync(transcriptPath, userLine + "\n" + assistantLine + "\n");

    // Write transcript-path.txt sidecar.
    fs.writeFileSync(path.join(tmpDir, "transcript-path.txt"), transcriptPath + "\n");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("materializes a scenario from a capture pointer and snapshot", async () => {
    // Create epoch + snapshot + capture.
    const epoch = rotateEpoch(tmpDir, "initial", null);
    const state = sessionStateDefaults();
    const snapshotSeq = appendStateSnapshot(tmpDir, state, transcriptPath);

    appendCapture(tmpDir, {
      ts: Date.now(),
      epoch_id: epoch.id,
      parent_capture_seq: null,
      event: "Stop",
      decision: "pass",
      state_snapshot_seq: snapshotSeq,
    });

    const scenario = await materializeScenario(tmpDir, 1);

    expect(scenario.schema_version).toBe(2);
    expect(scenario.name).toMatch(/materialized-seq-1/);
    expect(scenario.transcript.length).toBeGreaterThan(0);
    expect(scenario.target.hook).toBe("Stop");
    expect(scenario.seed_state).toBeDefined();
    expect(scenario.seed_state.forceCheckPending).toBe(false);
    expect(scenario.seed_state.frustrationStreak).toBe(0);
  });

  it("throws when capture seq does not exist", async () => {
    await expect(materializeScenario(tmpDir, 999)).rejects.toThrow(
      /capture seq 999 not found/,
    );
  });

  it("throws when transcript-path.txt sidecar is missing", async () => {
    const epoch = rotateEpoch(tmpDir, "initial", null);
    const state = sessionStateDefaults();
    const snapshotSeq = appendStateSnapshot(tmpDir, state, transcriptPath);
    appendCapture(tmpDir, {
      ts: Date.now(),
      epoch_id: epoch.id,
      parent_capture_seq: null,
      event: "Stop",
      decision: "pass",
      state_snapshot_seq: snapshotSeq,
    });
    fs.unlinkSync(path.join(tmpDir, "transcript-path.txt"));

    await expect(materializeScenario(tmpDir, 1)).rejects.toThrow(
      /transcript-path\.txt sidecar not found/,
    );
  });
});
