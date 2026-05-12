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

  it("targets the captured tool use and seeds prior tool-log state", async () => {
    const userLine = JSON.stringify({
      uuid: "uuid-user-001",
      type: "user",
      message: { role: "user", content: "inspect files" },
      parentUuid: null,
    });
    const firstToolLine = JSON.stringify({
      uuid: "uuid-asst-002",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_target",
            name: "Read",
            input: { file_path: "/tmp/a.txt" },
          },
        ],
      },
      parentUuid: "uuid-user-001",
    });
    const resultLine = JSON.stringify({
      uuid: "uuid-user-003",
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_target",
            content: "ok",
          },
        ],
      },
      parentUuid: "uuid-asst-002",
    });
    const laterToolLine = JSON.stringify({
      uuid: "uuid-asst-004",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_later",
            name: "Read",
            input: { file_path: "/tmp/b.txt" },
          },
        ],
      },
      parentUuid: "uuid-user-003",
    });
    fs.writeFileSync(
      transcriptPath,
      [userLine, firstToolLine, resultLine, laterToolLine].join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(tmpDir, "tool-log.jsonl"),
      [
        JSON.stringify({
          ts: 100,
          tool: "Glob",
          status: "allowed",
          gate: "all-rules",
          ms: 1,
        }),
        JSON.stringify({
          ts: 200,
          tool: "Read",
          toolUseId: "toolu_target",
          path: "/tmp/a.txt",
          status: "allowed",
          gate: "all-rules",
          reason: "All checks passed",
          ms: 2,
        }),
      ].join("\n") + "\n",
    );

    const epoch = rotateEpoch(tmpDir, "initial", null);
    const state = sessionStateDefaults();
    const snapshotSeq = appendStateSnapshot(tmpDir, state, transcriptPath);

    appendCapture(tmpDir, {
      ts: Date.now(),
      epoch_id: epoch.id,
      parent_capture_seq: null,
      event: "PreToolUse",
      tool_use_id: "toolu_target",
      decision: "allow",
      state_snapshot_seq: snapshotSeq,
    });

    const scenario = await materializeScenario(tmpDir, 1);

    expect(scenario.target).toEqual({
      hook: "PreToolUse",
      tool_use_ref: "toolu_target",
    });
    expect(scenario.transcript).toHaveLength(2);
    expect(scenario.transcript.at(-1)).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "toolu_target",
        },
      ],
    });
    expect(scenario.seed_state.toolLog).toEqual([
      {
        ts: 100,
        tool: "Glob",
        status: "allowed",
        gate: "all-rules",
        ms: 1,
      },
    ]);
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
