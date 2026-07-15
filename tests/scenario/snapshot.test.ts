import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { appendStateSnapshot } from "../../src/scenario/snapshot.js";
import { loadStateSnapshot } from "../../src/scenario/snapshot.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { sessionStateSnapshotsFile } from "../../src/utils/paths.js";

describe("state snapshots", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-snapshot-test-"));
    transcriptPath = path.join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("captures transcript UUIDs from the bounded tail only", () => {
    const oldLine = JSON.stringify({
      uuid: "uuid-too-old",
      padding: "x".repeat(300 * 1024),
    });
    const recentLine = JSON.stringify({ uuid: "uuid-recent" });
    fs.writeFileSync(transcriptPath, `${oldLine}\n${recentLine}\n`);

    const seq = appendStateSnapshot(tmpDir, sessionStateDefaults(), transcriptPath);
    const records = fs.readFileSync(sessionStateSnapshotsFile(tmpDir), "utf-8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { seq: number; transcript_uuids_tail: string[] });

    expect(seq).toBe(1);
    expect(records[0].transcript_uuids_tail).toEqual(["uuid-recent"]);
  });

  it("skips malformed-shape snapshot and transcript JSONL records", () => {
    const snapshotPath = sessionStateSnapshotsFile(tmpDir);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(
      snapshotPath,
      [
        "null",
        JSON.stringify("not an object"),
        JSON.stringify({
          seq: 3,
          ts: 123,
          state: sessionStateDefaults(),
          tool_log_offset: 0,
          gate_reasoning_hash: null,
          plan_mode_state: null,
          injection_log_offset: 0,
          injection_log_hash: null,
          transcript_uuids_tail: [],
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      transcriptPath,
      [
        "null",
        JSON.stringify("not an object"),
        JSON.stringify({ uuid: "uuid-recent" }),
      ].join("\n") + "\n",
    );

    expect(loadStateSnapshot(tmpDir, 1)).toBeNull();
    expect(loadStateSnapshot(tmpDir, 3)?.seq).toBe(3);

    const seq = appendStateSnapshot(tmpDir, {
      ...sessionStateDefaults(),
      frustrationStreak: 1,
    }, transcriptPath);
    const records = fs.readFileSync(snapshotPath, "utf-8")
      .trim()
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as { seq?: number; transcript_uuids_tail?: string[] };
        } catch {
          return null;
        }
      });
    const appended = records.find((record) => record?.seq === seq);
    expect(appended?.transcript_uuids_tail).toEqual(["uuid-recent"]);
  });

  it("loads the previous snapshot from the bounded log tail when appending", () => {
    const snapshotPath = sessionStateSnapshotsFile(tmpDir);
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    fs.writeFileSync(transcriptPath, `${JSON.stringify({ uuid: "uuid-recent" })}\n`);
    fs.writeFileSync(
      snapshotPath,
      `${JSON.stringify({ seq: 1, padding: "x".repeat(300 * 1024) })}\n` +
        `${JSON.stringify({
          seq: 41,
          state: sessionStateDefaults(),
          tool_log_offset: 1,
          gate_reasoning_hash: null,
          plan_mode_state: null,
          injection_log_offset: 0,
          injection_log_hash: null,
          transcript_uuids_tail: ["older"],
        })}\n`,
    );

    const seq = appendStateSnapshot(tmpDir, sessionStateDefaults(), transcriptPath);

    expect(seq).toBe(42);
  });
});
