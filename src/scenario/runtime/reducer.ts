import type { JsonValue } from "../protocol/common.js";
import { canonicalJsonEqual } from "../protocol/canonical-json.js";
import { digestScenarioValue } from "../protocol/digest.js";
import { feedbackEntrySchema } from "../protocol/feedback.js";
import type { ScenarioRecord } from "../protocol/records.js";
import {
  isTerminalMessageStatus,
  isTerminalToolStatus,
  stateSliceSchema,
  type ScenarioSnapshot,
} from "../protocol/snapshot.js";
import type { RunManifest } from "../store/types.js";

export function emptyScenarioSnapshot(manifest: RunManifest): ScenarioSnapshot {
  return {
    runId: manifest.runId,
    identity: {
      sourceKind: manifest.source.kind,
      workingDir: manifest.workingDir,
      projectDir: manifest.projectDir,
      engineVersion: manifest.engineVersion,
      schemaDigest: manifest.schemaDigest,
    },
    manifest: {
      source: manifest.source,
      adapter: manifest.adapter,
      provider: manifest.provider,
      nativeSessionIds: manifest.nativeSessionIds,
      storagePolicy: manifest.storagePolicy,
      runtimeHome: manifest.runtimeHome,
      configuration: manifest.configuration,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    },
    status: "created",
    capabilities: manifest.capabilities,
    revision: 0,
    lastRecordSeq: 0,
    conversation: [],
    toolCalls: [],
    stateSlices: initialStateSlices(manifest),
    effects: [],
    providerState: {},
    plan: {},
    continuation: {},
    artifacts: [],
    feedback: {},
    errors: [],
    recoveryDiagnostics: [],
    commandResults: {},
  };
}

function initialStateSlices(manifest: RunManifest): ScenarioSnapshot["stateSlices"] {
  return {
    "store.health": {
      key: "store.health",
      schemaId: "scenario://state/store-health",
      revision: 1,
      status: "loaded",
      source: "runManifest.storageHealth",
      updatedAt: manifest.createdAt,
      visibility: "public",
      value: { storagePolicy: manifest.storagePolicy, diagnostics: [] },
      diagnostics: [],
    },
  };
}

export function reduceScenarioRecord(snapshot: ScenarioSnapshot, record: ScenarioRecord): ScenarioSnapshot {
  if (record.runId !== snapshot.runId) throw new Error(`Record run mismatch: ${record.runId}`);
  if (record.recordSeq !== snapshot.lastRecordSeq + 1) {
    throw new Error(`Record sequence mismatch: got ${record.recordSeq}, expected ${snapshot.lastRecordSeq + 1}`);
  }
  const next = structuredClone(snapshot);
  const payload = record.payload;

  switch (record.eventType) {
    case "command.accepted":
      next.commandResults[record.commandId] = payload.result ?? null;
      next.manifest.updatedAt = record.recordedAt;
      {
        const command = objectFieldOrEmpty(payload, "command");
        const source = objectFieldOrEmpty(command, "source");
        const adapter = optionalStringField(source, "adapter");
        const provider = optionalStringField(source, "provider");
        const nativeSessionId = optionalStringField(source, "nativeSessionId");
        if (adapter) next.manifest.adapter = adapter;
        if (provider) next.manifest.provider = provider;
        if (nativeSessionId && !next.manifest.nativeSessionIds.includes(nativeSessionId)) {
          next.manifest.nativeSessionIds.push(nativeSessionId);
        }
      }
      break;
    case "command.completed":
      next.commandResults[stringField(payload, "commandId")] = payload.result ?? null;
      break;
    case "run.started":
    case "run.resumed":
      next.status = "running";
      break;
    case "run.closed":
      next.status = "closed";
      break;
    case "run.cancelled":
      next.status = "cancelled";
      break;
    case "message.userSubmitted":
    case "message.assistantObserved":
    case "message.assistantCompleted":
    case "message.observed":
      reduceMessage(next, record);
      break;
    case "message.retired": {
      const messageId = stringField(payload, "messageId");
      if (!next.conversation.some((message) => message.id === messageId)) {
        throw new Error(`Cannot retire unknown message: ${messageId}`);
      }
      next.conversation = next.conversation.filter((message) => message.id !== messageId);
      break;
    }
    case "tool.requested":
      if (next.toolCalls.some((candidate) => candidate.id === stringField(payload, "toolCallId"))) {
        throw new Error(`Tool call ID is already committed: ${stringField(payload, "toolCallId")}`);
      }
      const tool: ScenarioSnapshot["toolCalls"][number] = {
        id: stringField(payload, "toolCallId"),
        turnId: nullableStringField(payload, "turnId"),
        name: stringField(payload, "name"),
        input: jsonField(payload, "input"),
        inputDigest: stringField(payload, "inputDigest"),
        feedbackDigest: "",
        status: "requested",
        authorization: {
          policy: "pending",
          user: "notRequired",
          final: "pending",
          reason: null,
        },
        output: [],
        error: null,
        createdAt: record.recordedAt,
        updatedAt: record.recordedAt,
        completedAt: null,
        recordSeq: record.recordSeq,
      };
      tool.feedbackDigest = toolFeedbackDigest(tool);
      next.toolCalls.push(tool);
      break;
    case "tool.retired": {
      const toolCallId = stringField(payload, "toolCallId");
      if (!next.toolCalls.some((toolCall) => toolCall.id === toolCallId)) {
        throw new Error(`Cannot retire unknown tool call: ${toolCallId}`);
      }
      next.toolCalls = next.toolCalls.filter((toolCall) => toolCall.id !== toolCallId);
      break;
    }
    case "tool.authorization.policyResolved":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        tool.authorization.policy = enumField(payload, "policy", ["pending", "allowed", "denied", "failed", "notEnforced"]);
        tool.authorization.reason = nullableStringField(payload, "reason");
      });
      break;
    case "tool.authorization.userDecisionPending":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        tool.authorization.user = "pending";
        tool.status = "waiting";
      });
      break;
    case "tool.authorization.userDecisionSubmitted":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        tool.authorization.user = stringField(payload, "decision") === "approve" ? "approved" : "denied";
      });
      break;
    case "tool.authorization.userUnavailable":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        tool.authorization.user = "unavailable";
      });
      break;
    case "tool.authorization.finalResolved":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        const final = enumField(payload, "final", ["pending", "allowed", "denied", "cancelled", "failed", "observed"]);
        tool.authorization.final = final;
        tool.authorization.reason = nullableStringField(payload, "reason");
        if (final === "denied" || final === "failed") {
          tool.status = final;
          tool.error = tool.authorization.reason ?? (final === "failed" ? "Tool authorization failed" : null);
          tool.completedAt = record.recordedAt;
        }
      });
      break;
    case "tool.executionStarted":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        assertToolTransition(tool, ["requested", "waiting"], record.eventType);
        tool.status = "running";
        tool.error = null;
        tool.completedAt = null;
      });
      break;
    case "tool.outputAppended":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        assertToolTransition(tool, ["running"], record.eventType);
        tool.output.push(jsonField(payload, "output"));
      });
      break;
    case "tool.completed":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        assertToolTransition(tool, ["running"], record.eventType);
        tool.status = "completed";
        tool.completedAt = record.recordedAt;
        if (payload.output !== undefined) tool.output.push(payload.output);
      });
      break;
    case "tool.failed":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        assertToolTransition(tool, ["running"], record.eventType);
        tool.status = "failed";
        tool.error = optionalStringField(payload, "error") ?? "Tool execution failed";
        tool.completedAt = record.recordedAt;
        if (payload.output !== undefined) tool.output.push(payload.output);
      });
      break;
    case "tool.cancelled":
      updateTool(next, payload, record.recordedAt, record.recordSeq, (tool) => {
        if (isTerminalToolStatus(tool.status)) {
          throw new Error(`tool.cancelled is not allowed while tool status is ${tool.status}`);
        }
        tool.status = "cancelled";
        tool.error = optionalStringField(payload, "error") ?? null;
        tool.completedAt = record.recordedAt;
      });
      break;
    case "effect.progressed": {
      updateEffect(next, payload, (effect) => {
        effect.claimRenewedAt = record.recordedAt;
      });
      break;
    }
    case "state.sliceChanged": {
      const slice = stateSliceSchema.parse(jsonField(payload, "slice"));
      next.stateSlices[slice.key] = slice;
      break;
    }
    case "store.diagnostic": {
      const message = stringField(payload, "message");
      if (!next.recoveryDiagnostics.includes(message)) next.recoveryDiagnostics.push(message);
      const prior = next.stateSlices["store.health"];
      const diagnostics = [...(prior?.diagnostics ?? [])];
      if (!diagnostics.includes(message)) diagnostics.push(message);
      next.stateSlices["store.health"] = {
        key: "store.health",
        schemaId: "scenario://state/store-health",
        revision: (prior?.revision ?? 0) + 1,
        status: "recovered",
        source: optionalStringField(payload, "source") ?? "runStore",
        updatedAt: record.recordedAt,
        visibility: "localSensitive",
        value: {
          lastDiagnostic: message,
          lastStatus: optionalStringField(payload, "status") ?? "recovered",
        },
        diagnostics,
      };
      break;
    }
    case "recovery.completed": {
      const message = stringField(payload, "message");
      if (!next.recoveryDiagnostics.includes(message)) next.recoveryDiagnostics.push(message);
      break;
    }
    case "effect.requested":
      next.effects.push({
        effectId: stringField(payload, "effectId"),
        effectType: stringField(payload, "effectType"),
        claimId: null,
        status: "requested",
        parameters: payload.parameters ?? null,
        error: null,
        requestedAt: record.recordedAt,
        startedAt: null,
        claimRenewedAt: null,
        completedAt: null,
        metadata: {},
      });
      break;
    case "effect.started":
      updateEffect(next, payload, (effect) => {
        effect.status = "started";
        effect.claimId = stringField(payload, "claimId");
        effect.startedAt = record.recordedAt;
        effect.claimRenewedAt = record.recordedAt;
      });
      break;
    case "effect.claimRenewed":
      updateEffect(next, payload, (effect) => {
        effect.claimRenewedAt = record.recordedAt;
      });
      break;
    case "effect.completed":
      updateEffect(next, payload, (effect) => {
        effect.status = "completed";
        effect.result = payload.result ?? null;
        effect.metadata = objectFieldOrEmpty(payload, "metadata");
        effect.completedAt = record.recordedAt;
      });
      break;
    case "effect.failed":
      updateEffect(next, payload, (effect) => {
        effect.status = "failed";
        effect.error = optionalStringField(payload, "error") ?? "Effect failed";
        effect.completedAt = record.recordedAt;
      });
      break;
    case "effect.cancelled":
      updateEffect(next, payload, (effect) => {
        effect.status = "cancelled";
        effect.completedAt = record.recordedAt;
      });
      break;
    case "provider.stateObserved":
      next.providerState = { ...next.providerState, ...objectField(payload, "state") };
      break;
    case "plan.stateChanged":
      next.plan = objectField(payload, "state");
      break;
    case "continuation.stateChanged":
      next.continuation = objectField(payload, "state");
      break;
    case "artifact.linked": {
      const artifact = payload.artifact as ScenarioSnapshot["artifacts"][number];
      const existing = next.artifacts.find((candidate) => candidate.artifactId === artifact.artifactId);
      if (!existing) next.artifacts.push(artifact);
      else if (!canonicalJsonEqual(existing, artifact)) {
        throw new Error(`Artifact identity changed: ${artifact.artifactId}`);
      }
      break;
    }
    case "feedback.changed": {
      const feedback = feedbackEntrySchema.parse(jsonField(payload, "feedback"));
      next.feedback[`${feedback.author.subjectId}:${feedback.target.kind}:${feedback.target.id}`] = feedback;
      break;
    }
    case "runtime.error":
      next.errors.push({
        code: optionalStringField(payload, "code") ?? "runtime_error",
        message: stringField(payload, "message"),
        recoverable: payload.recoverable === true,
        metadata: objectFieldOrEmpty(payload, "metadata"),
        recordedAt: record.recordedAt,
      });
      if (payload.recoverable !== true) next.status = "failed";
      break;
    default:
      break;
  }

  next.lastRecordSeq = record.recordSeq;
  next.manifest.updatedAt = record.recordedAt;
  return next;
}

export function reduceScenarioRecords(
  snapshot: ScenarioSnapshot,
  records: readonly ScenarioRecord[],
  resultingRevision: number = snapshot.revision + (records.length > 0 ? 1 : 0),
): ScenarioSnapshot {
  const reduced = records.reduce(reduceScenarioRecord, snapshot);
  if (records.length > 0) reduced.revision = resultingRevision;
  return reduced;
}

/** Count committed command batches represented by a contiguous journal prefix. */
export function scenarioJournalRevision(records: readonly ScenarioRecord[]): number {
  let revision = 0;
  let commandId: string | null = null;
  for (const record of records) {
    if (record.commandId === commandId) continue;
    commandId = record.commandId;
    revision += 1;
  }
  return revision;
}

function reduceMessage(next: ScenarioSnapshot, record: ScenarioRecord): void {
  const payload = record.payload;
  const id = stringField(payload, "messageId");
  const existing = next.conversation.find((message) => message.id === id);
  const role = record.eventType === "message.observed"
    ? enumField(payload, "role", ["user", "assistant", "system", "synthetic"])
    : record.eventType === "message.userSubmitted" ? "user" : "assistant";
  const status = record.eventType === "message.observed"
    ? enumField(payload, "status", ["streaming", "completed", "failed"])
    : record.eventType === "message.assistantObserved" ? "streaming" : "completed";
  if (existing) {
    const turnId = nullableStringField(payload, "turnId");
    if (existing.role !== role || existing.turnId !== turnId) {
      throw new Error(`Message identity changed: ${id}`);
    }
    if (existing.role === "user" || isTerminalMessageStatus(existing.status)) {
      throw new Error(`Message is already terminal: ${id}`);
    }
    existing.recordSeq = record.recordSeq;
    existing.content = stringField(payload, "content");
    existing.contentDigest = stringField(payload, "contentDigest");
    existing.status = status;
    existing.updatedAt = record.recordedAt;
    existing.completedAt = isTerminalMessageStatus(status) ? record.recordedAt : null;
    if (payload.usage !== undefined) existing.usage = payload.usage;
    return;
  }
  next.conversation.push({
    id,
    turnId: nullableStringField(payload, "turnId"),
    role,
    content: stringField(payload, "content"),
    contentDigest: stringField(payload, "contentDigest"),
    status,
    createdAt: record.recordedAt,
    updatedAt: record.recordedAt,
    completedAt: isTerminalMessageStatus(status) ? record.recordedAt : null,
    recordSeq: record.recordSeq,
    ...(payload.usage === undefined ? {} : { usage: payload.usage }),
  });
}

function assertToolTransition(
  tool: ScenarioSnapshot["toolCalls"][number],
  allowed: readonly ScenarioSnapshot["toolCalls"][number]["status"][],
  eventType: string,
): void {
  if (!allowed.includes(tool.status)) {
    throw new Error(`${eventType} is not allowed while tool status is ${tool.status}`);
  }
}

function updateTool(
  snapshot: ScenarioSnapshot,
  payload: Record<string, JsonValue>,
  updatedAt: string,
  recordSeq: number,
  update: (tool: ScenarioSnapshot["toolCalls"][number]) => void,
): void {
  const id = stringField(payload, "toolCallId");
  const tool = snapshot.toolCalls.find((item) => item.id === id);
  if (!tool) throw new Error(`Unknown tool call: ${id}`);
  if (isTerminalToolStatus(tool.status)) throw new Error(`Tool call is already terminal: ${id}`);
  update(tool);
  tool.updatedAt = updatedAt;
  tool.recordSeq = recordSeq;
  tool.feedbackDigest = toolFeedbackDigest(tool);
}

export function toolFeedbackDigest(tool: Pick<ScenarioSnapshot["toolCalls"][number],
  "status" | "inputDigest" | "output" | "error" | "authorization"
>): string {
  const semanticTarget = {
    status: tool.status,
    inputDigest: tool.inputDigest,
    output: tool.output,
    error: tool.error,
    authorization: tool.authorization,
  };
  return digestScenarioValue(semanticTarget);
}

function updateEffect(
  snapshot: ScenarioSnapshot,
  payload: Record<string, JsonValue>,
  update: (effect: ScenarioSnapshot["effects"][number]) => void,
): void {
  const id = stringField(payload, "effectId");
  const effect = snapshot.effects.find((item) => item.effectId === id);
  if (!effect) throw new Error(`Unknown effect: ${id}`);
  update(effect);
}

function stringField(payload: Record<string, JsonValue>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string") throw new Error(`Expected string payload field: ${key}`);
  return value;
}

function optionalStringField(payload: Record<string, JsonValue>, key: string): string | undefined {
  const value = payload[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`Expected optional string payload field: ${key}`);
  return value;
}

function nullableStringField(payload: Record<string, JsonValue>, key: string): string | null {
  const value = payload[key];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`Expected nullable string payload field: ${key}`);
  return value;
}

function jsonField(payload: Record<string, JsonValue>, key: string): JsonValue {
  const value = payload[key];
  if (value === undefined) throw new Error(`Expected payload field: ${key}`);
  return value;
}

function objectField(payload: Record<string, JsonValue>, key: string): Record<string, JsonValue> {
  const value = jsonField(payload, key);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Expected object payload field: ${key}`);
  }
  return value;
}

function objectFieldOrEmpty(payload: Record<string, JsonValue>, key: string): Record<string, JsonValue> {
  return payload[key] === undefined ? {} : objectField(payload, key);
}

function enumField<const T extends readonly string[]>(
  payload: Record<string, JsonValue>,
  key: string,
  values: T,
): T[number] {
  const value = stringField(payload, key);
  if (!values.includes(value)) throw new Error(`Unexpected ${key}: ${value}`);
  return value;
}
