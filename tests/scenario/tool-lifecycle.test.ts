import { describe, expect, it } from "vitest";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import {
  canonicalToolTerminalTarget,
  isIdenticalToolTerminalReplay,
  observedToolLifecycleRecords,
  toolTerminalLifecycle,
  toolTerminalLifecycleFromCommandType,
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
  it("owns every terminal status, command, event, and default in one mapping", () => {
    expect(["completed", "failed", "cancelled"].map((status) =>
      toolTerminalLifecycle(status as "completed" | "failed" | "cancelled")
    )).toEqual([
      {
        status: "completed",
        commandType: "toolCompleted",
        eventType: "tool.completed",
        defaultError: null,
      },
      {
        status: "failed",
        commandType: "toolFailed",
        eventType: "tool.failed",
        defaultError: "Tool execution failed",
      },
      {
        status: "cancelled",
        commandType: "toolCancelled",
        eventType: "tool.cancelled",
        defaultError: "Tool cancelled",
      },
    ]);
    expect(toolTerminalLifecycleFromCommandType("toolFailed")?.eventType).toBe(
      "tool.failed",
    );
  });

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

  it("normalizes terminal errors and compares replays through one canonical policy", () => {
    expect(canonicalToolTerminalTarget({ status: "failed", error: null })).toMatchObject({
      status: "failed",
      error: "Tool execution failed",
    });
    expect(canonicalToolTerminalTarget({ status: "cancelled", error: null })).toMatchObject({
      status: "cancelled",
      error: "Tool cancelled",
    });
    expect(isIdenticalToolTerminalReplay({
      status: "cancelled",
      output: [],
      error: "custom cancellation",
    }, {
      status: "cancelled",
      error: null,
    })).toBe(false);
    expect(isIdenticalToolTerminalReplay({
      status: "cancelled",
      output: [],
      error: "Tool cancelled",
    }, {
      status: "cancelled",
      error: null,
    })).toBe(true);
    expect(isIdenticalToolTerminalReplay({
      status: "cancelled",
      output: ["existing output"],
      error: "Tool cancelled",
    }, {
      status: "cancelled",
      error: null,
    })).toBe(true);
    expect(isIdenticalToolTerminalReplay({
      status: "cancelled",
      output: ["existing output"],
      error: "Tool cancelled",
    }, {
      status: "cancelled",
      terminalOutput: "different output",
      error: null,
    })).toBe(false);
  });
});
