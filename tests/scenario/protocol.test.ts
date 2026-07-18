import { describe, expect, it } from "vitest";
import { scenarioCommandPayloadSchema } from "../../src/scenario/protocol/commands.js";
import { feedbackEntrySchema } from "../../src/scenario/protocol/feedback.js";
import { eventBatchSchema, type ScenarioRecord } from "../../src/scenario/protocol/records.js";
import { timestampSchema } from "../../src/scenario/protocol/common.js";
import { createScenarioCommandEnvelope } from "../../src/scenario/protocol/command-envelope.js";

const digest = `sha256:${"a".repeat(64)}`;

describe("Scenario protocol invariants", () => {
  it("constructs one canonical command envelope from injected identity and clock providers", () => {
    const command = createScenarioCommandEnvelope({
      runId: "run-1",
      source: { kind: "providerSdk", adapter: "claude", provider: "openrouter" },
      expectedSnapshotRevision: 7,
      correlationId: "correlation-1",
      causationId: "causation-1",
      payload: { type: "cancelRun" },
    }, {
      idFactory: () => "generated-command",
      clock: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(command).toEqual({
      commandId: "generated-command",
      runId: "run-1",
      source: { kind: "providerSdk", adapter: "claude", provider: "openrouter" },
      recordedAt: "2026-07-15T12:00:00.000Z",
      expectedSnapshotRevision: 7,
      correlationId: "correlation-1",
      causationId: "causation-1",
      payload: { type: "cancelRun" },
    });
  });

  it("accepts only ISO-8601 datetimes with an explicit UTC offset", () => {
    expect(timestampSchema.safeParse("2026-07-15T12:00:00.000Z").success).toBe(true);
    expect(timestampSchema.safeParse("2026-07-15T14:00:00+02:00").success).toBe(true);
    for (const invalid of ["not-a-date", "2026-07-15", "2026-07-15T12:00:00", "2026-13-40T99:99:99Z"]) {
      expect(timestampSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("uses Unicode code points for feedback note limits in submissions and stored entries", () => {
    const noteAtLimit = "😀".repeat(280);
    const noteOverLimit = "😀".repeat(281);
    const submission = {
      type: "submitFeedback",
      targetKind: "assistantMessage",
      targetId: "message-1",
      vote: "up",
      idempotencyKey: "feedback-1",
      expectedTargetDigest: digest,
      author: { subjectId: "user-1", clientId: "client-1", clientVersion: "1" },
    };
    const entry = {
      feedbackId: "feedback-1",
      runId: "run-1",
      target: { kind: "assistantMessage", id: "message-1", recordSeq: 1, digest },
      vote: "up",
      createdAt: "2026-07-15T12:00:00.000Z",
      author: submission.author,
      supersedesFeedbackId: null,
      idempotencyKey: submission.idempotencyKey,
    };

    expect(scenarioCommandPayloadSchema.safeParse({ ...submission, note: noteAtLimit }).success).toBe(true);
    expect(feedbackEntrySchema.safeParse({ ...entry, note: noteAtLimit }).success).toBe(true);
    expect(scenarioCommandPayloadSchema.safeParse({ ...submission, note: noteOverLimit }).success).toBe(false);
    expect(feedbackEntrySchema.safeParse({ ...entry, note: noteOverLimit }).success).toBe(false);
  });

  it.each([
    {
      name: "a record from another run",
      mutate: (record: ScenarioRecord) => ({ ...record, runId: "other-run" }),
      path: ["records", 0, "runId"],
    },
    {
      name: "a record sequence outside its batch position",
      mutate: (record: ScenarioRecord) => ({ ...record, recordSeq: 3 }),
      path: ["records", 0, "recordSeq"],
    },
  ])("rejects $name", ({ mutate, path }) => {
    const record: ScenarioRecord = {
      runId: "run-1",
      recordSeq: 2,
      recordId: "record-2",
      recordedAt: "2026-07-15T12:00:00.000Z",
      commandId: "command-1",
      eventType: "plan.stateChanged",
      visibility: "localSensitive",
      payload: { state: { step: 1 } },
    };
    const result = eventBatchSchema.safeParse({
      runId: "run-1",
      fromSeq: 2,
      toSeq: 2,
      baseSnapshotRevision: 1,
      resultingSnapshotRevision: 2,
      records: [mutate(record)],
    });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(path);
  });
});
