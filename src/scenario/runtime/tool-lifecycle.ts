import { toJsonValue, type JsonValue } from "../protocol/common.js";
import type { ScenarioEventType, ScenarioRecord } from "../protocol/records.js";
import type { ScenarioSnapshot } from "../protocol/snapshot.js";
import { redactScenarioValue } from "./redaction.js";
import { canonicalJsonEqual } from "../protocol/canonical-json.js";

export type ToolLifecycleRecord = {
  eventType: ScenarioEventType;
  payload: Record<string, JsonValue>;
  entityRef: { kind: "toolCall"; id: string };
  visibility: ScenarioRecord["visibility"];
};

export type ObservedToolDescriptor = {
  toolCallId: string;
  turnId: string | null;
  name: string;
  input: JsonValue;
  inputDigest: string;
  requiresUserDecision?: boolean;
};

export type ObservedToolAuthorization = {
  policy: "allowed" | "denied" | "failed" | "notEnforced";
  final: "allowed" | "denied" | "failed" | "observed";
  policyReason: string | null;
  finalReason: string | null;
  userUnavailable?: "always" | "ifPending";
};

export type ObservedToolTarget = {
  status: "requested" | "waiting" | "running" | "completed" | "failed" | "cancelled" | "denied";
  appendedOutput?: readonly JsonValue[];
  terminalOutput?: JsonValue;
  error?: string | null;
};

export type ToolTerminalTarget = {
  status: "completed" | "failed" | "cancelled";
  terminalOutput?: JsonValue;
  error?: string | null;
};

export type ToolTerminalLifecycle = {
  status: ToolTerminalTarget["status"];
  commandType: "toolCompleted" | "toolFailed" | "toolCancelled";
  eventType: "tool.completed" | "tool.failed" | "tool.cancelled";
  defaultError: string | null;
};

const TOOL_TERMINAL_LIFECYCLES = {
  completed: {
    status: "completed",
    commandType: "toolCompleted",
    eventType: "tool.completed",
    defaultError: null,
  },
  failed: {
    status: "failed",
    commandType: "toolFailed",
    eventType: "tool.failed",
    defaultError: "Tool execution failed",
  },
  cancelled: {
    status: "cancelled",
    commandType: "toolCancelled",
    eventType: "tool.cancelled",
    defaultError: "Tool cancelled",
  },
} as const satisfies Record<ToolTerminalTarget["status"], ToolTerminalLifecycle>;

export function toolTerminalLifecycle(
  status: ToolTerminalTarget["status"],
): ToolTerminalLifecycle {
  return TOOL_TERMINAL_LIFECYCLES[status];
}

export function toolTerminalLifecycleFromCommandType(
  commandType: string,
): ToolTerminalLifecycle | null {
  return Object.values(TOOL_TERMINAL_LIFECYCLES).find(
    (lifecycle) => lifecycle.commandType === commandType,
  ) ?? null;
}

export type CanonicalToolTerminalTarget = {
  status: ToolTerminalTarget["status"];
  terminalOutput?: JsonValue;
  error: string | null;
};

type TerminalToolSnapshot = Pick<
  ScenarioSnapshot["toolCalls"][number],
  "status" | "output" | "error"
>;

/** Normalize every entry path to the terminal state authored by the reducer. */
export function canonicalToolTerminalTarget(target: ToolTerminalTarget): CanonicalToolTerminalTarget {
  const lifecycle = toolTerminalLifecycle(target.status);
  return {
    status: lifecycle.status,
    ...(target.terminalOutput === undefined ? {} : { terminalOutput: target.terminalOutput }),
    error: lifecycle.defaultError === null
      ? null
      : target.error ?? lifecycle.defaultError,
  };
}

/** Compare a repeated terminal observation after canonical normalization. */
export function isIdenticalToolTerminalReplay(
  tool: TerminalToolSnapshot,
  target: ToolTerminalTarget,
): boolean {
  const canonical = canonicalToolTerminalTarget(target);
  return tool.status === canonical.status &&
    tool.error === canonical.error &&
    (canonical.terminalOutput === undefined
      ? true
      :
      canonicalJsonEqual(tool.output.at(-1), canonical.terminalOutput));
}

export function canonicalToolTerminalPayload(
  toolCallId: string,
  target: ToolTerminalTarget,
): Record<string, JsonValue> {
  const canonical = canonicalToolTerminalTarget(target);
  const lifecycle = toolTerminalLifecycle(canonical.status);
  return {
    type: lifecycle.commandType,
    toolCallId,
    ...(canonical.terminalOutput === undefined ? {} : { output: canonical.terminalOutput }),
    ...(canonical.error === null ? {} : { error: canonical.error }),
  };
}

type ExistingTool = Pick<
  ScenarioSnapshot["toolCalls"][number],
  "status" | "authorization" | "output"
>;

/**
 * Build the canonical lifecycle for a tool first discovered after native
 * execution or while reconciling native history. Entry points supply only
 * their policy interpretation and target state; this helper owns record
 * payloads, visibility, and transition ordering.
 */
export function observedToolLifecycleRecords(input: {
  tool: ObservedToolDescriptor;
  existing?: ExistingTool;
  authorization: ObservedToolAuthorization;
  target: ObservedToolTarget;
}): ToolLifecycleRecord[] {
  const { tool, authorization, target } = input;
  const current = input.existing ?? {
    status: "requested" as const,
    authorization: {
      policy: "pending" as const,
      user: "notRequired" as const,
      final: "pending" as const,
      reason: null,
    },
    output: [] as JsonValue[],
  };
  const records: ToolLifecycleRecord[] = [];

  if (!input.existing) records.push(canonicalToolRequestedRecord(tool));
  if (current.authorization.policy === "pending") {
    records.push(lifecycleRecord(tool.toolCallId, "tool.authorization.policyResolved", {
      toolCallId: tool.toolCallId,
      policy: authorization.policy,
      reason: authorization.policyReason,
    }));
  }
  const userBecameUnavailable = (
    authorization.userUnavailable === "always" && current.authorization.user !== "unavailable" ||
    authorization.userUnavailable === "ifPending" && current.authorization.user === "pending"
  );
  if (userBecameUnavailable) {
    records.push(lifecycleRecord(tool.toolCallId, "tool.authorization.userUnavailable", {
      toolCallId: tool.toolCallId,
    }));
  }
  if (current.authorization.final === "pending") {
    records.push(lifecycleRecord(tool.toolCallId, "tool.authorization.finalResolved", {
      toolCallId: tool.toolCallId,
      final: authorization.final,
      reason: authorization.finalReason,
    }));
  }

  if (target.status === "requested" || target.status === "waiting" || target.status === "denied") {
    return records;
  }
  if (current.status === "requested" || current.status === "waiting") {
    records.push(lifecycleRecord(tool.toolCallId, "tool.executionStarted", {
      toolCallId: tool.toolCallId,
    }));
  } else if (current.status !== "running") {
    throw new Error(`Observed tool cannot advance from terminal status ${current.status}`);
  }
  for (const output of missingOutputs(current.output, target.appendedOutput ?? [])) {
    records.push(lifecycleRecord(tool.toolCallId, "tool.outputAppended", {
      toolCallId: tool.toolCallId,
      output,
    }));
  }
  if (target.status === "running") return records;

  const terminalTarget: ToolTerminalTarget = {
    status: target.status === "completed"
      ? "completed"
      : target.status === "failed" ? "failed" : "cancelled",
    ...(target.terminalOutput === undefined ? {} : { terminalOutput: target.terminalOutput }),
    error: target.error,
  };
  const terminalType = toolTerminalLifecycle(terminalTarget.status).eventType;
  records.push(lifecycleRecord(
    tool.toolCallId,
    terminalType,
    canonicalToolTerminalPayload(tool.toolCallId, terminalTarget),
  ));
  return records;
}

export function canonicalToolRequestedRecord(tool: ObservedToolDescriptor): ToolLifecycleRecord {
  return lifecycleRecord(tool.toolCallId, "tool.requested", redactScenarioValue(toJsonValue({
    type: "toolRequested",
    toolCallId: tool.toolCallId,
    turnId: tool.turnId,
    name: tool.name,
    input: tool.input,
    inputDigest: tool.inputDigest,
    requiresUserDecision: tool.requiresUserDecision ?? false,
  })) as Record<string, JsonValue>);
}

function lifecycleRecord(
  toolCallId: string,
  eventType: ScenarioEventType,
  payload: Record<string, JsonValue>,
): ToolLifecycleRecord {
  return {
    eventType,
    entityRef: { kind: "toolCall", id: toolCallId },
    visibility: "localSensitive",
    payload,
  };
}

function missingOutputs(existing: readonly JsonValue[], imported: readonly JsonValue[]): JsonValue[] {
  const existingIsPrefix = existing.length <= imported.length && existing.every((output, index) =>
    canonicalJsonEqual(output, imported[index])
  );
  if (!existingIsPrefix) {
    throw new Error("Observed tool output does not extend the canonical output prefix");
  }
  return imported.slice(existing.length);
}
