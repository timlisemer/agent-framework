import { describe, expect, it } from "vitest";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import {
  observedToolLifecycleRecords,
  type ObservedToolAuthorization,
} from "../../src/scenario/runtime/tool-lifecycle.js";

const tool = {
  toolCallId: "tool-1",
  turnId: "turn-1",
  name: "Read",
  input: { file_path: "/workspace/file.ts" },
  inputDigest: digestScenarioValue({ file_path: "/workspace/file.ts" }),
};

describe("observed tool lifecycle", () => {
  it.each([
    ["provider", {
      policy: "notEnforced",
      final: "observed",
      policyReason: "provider observation",
      finalReason: "provider observation",
    }],
    ["host", {
      policy: "allowed",
      final: "allowed",
      policyReason: "host observation",
      finalReason: "host observation",
    }],
    ["transcript", {
      policy: "notEnforced",
      final: "observed",
      policyReason: null,
      finalReason: null,
    }],
  ] satisfies Array<[string, ObservedToolAuthorization]>) (
    "uses the same canonical record shape and ordering for a %s observation",
    (_source, authorization) => {
      const records = observedToolLifecycleRecords({
        tool,
        authorization,
        target: { status: "completed", appendedOutput: ["done"] },
      });

      expect(records.map((record) => record.eventType)).toEqual([
        "tool.requested",
        "tool.authorization.policyResolved",
        "tool.authorization.finalResolved",
        "tool.executionStarted",
        "tool.outputAppended",
        "tool.completed",
      ]);
      expect(records.every((record) => record.visibility === "localSensitive")).toBe(true);
      expect(records[0]?.payload).toEqual({
        type: "toolRequested",
        toolCallId: tool.toolCallId,
        turnId: tool.turnId,
        name: tool.name,
        input: tool.input,
        inputDigest: tool.inputDigest,
        requiresUserDecision: false,
      });
      expect(records.at(-1)?.payload).toEqual({
        type: "toolCompleted",
        toolCallId: tool.toolCallId,
      });
    },
  );

  it("resolves pending user authorization before advancing an observed execution", () => {
    const records = observedToolLifecycleRecords({
      tool,
      existing: {
        status: "waiting",
        authorization: {
          policy: "allowed",
          user: "pending",
          final: "pending",
          reason: null,
        },
        output: [],
      },
      authorization: {
        policy: "allowed",
        final: "observed",
        policyReason: null,
        finalReason: "Native execution bypassed the pending prompt",
        userUnavailable: "ifPending",
      },
      target: { status: "failed", error: "native failure" },
    });

    expect(records.map((record) => record.eventType)).toEqual([
      "tool.authorization.userUnavailable",
      "tool.authorization.finalResolved",
      "tool.executionStarted",
      "tool.failed",
    ]);
    expect(records[1]?.payload).toMatchObject({
      final: "observed",
      reason: "Native execution bypassed the pending prompt",
    });
    expect(records[3]?.payload).toEqual({
      type: "toolFailed",
      toolCallId: tool.toolCallId,
      error: "native failure",
    });
  });

  it("rejects same-length output that diverges from the canonical prefix", () => {
    expect(() => observedToolLifecycleRecords({
      tool,
      existing: {
        status: "running",
        authorization: {
          policy: "allowed",
          user: "notRequired",
          final: "allowed",
          reason: null,
        },
        output: [{ line: "canonical" }],
      },
      authorization: {
        policy: "allowed",
        final: "allowed",
        policyReason: null,
        finalReason: null,
      },
      target: {
        status: "running",
        appendedOutput: [{ line: "different" }],
      },
    })).toThrow("does not extend the canonical output prefix");
  });
});
