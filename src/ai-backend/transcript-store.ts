import type {
  AiBackendProcess,
  AiBackendProcessId,
  AiContentBlock,
  AiContinuationState,
  AiErrorInfo,
  AiEvent,
  AiEventSeq,
  AiMetadata,
  AiMessageId,
  AiMessageRole,
  AiMessageStatus,
  AiPlanState,
  AiSessionConfig,
  AiSessionSnapshot,
  AiSessionStatus,
  AiSnapshotRevision,
  AiToolCall,
  AiToolInputSummary,
  AiToolOutputBlock,
  AiToolResult,
  AiToolStatus,
  AiTranscriptEntry,
  SessionId,
  TokenUsage,
  ToolCallId,
  TurnId,
} from "../ai-protocol/index.js";
import { resolveSessionTranscriptPathForProject } from "../utils/paths.js";

const defaultPlan: AiPlanState = {
  mode: "disabled",
  planText: null,
  approved: false,
};

export class TranscriptStore {
  readonly #sessions = new Map<SessionId, AiSessionSnapshot>();
  readonly #configs = new Map<SessionId, AiSessionConfig>();
  readonly #events = new Map<SessionId, AiEvent[]>();

  create(sessionId: SessionId, config: AiSessionConfig): AiSessionSnapshot {
    const now = new Date().toISOString();
    const snapshot: AiSessionSnapshot = {
      sessionId,
      workingDir: config.workingDir ?? process.cwd(),
      agentFrameworkSessionDir: null,
      status: "idle",
      revision: 0,
      lastEventSeq: 0,
      transcript: [],
      toolCalls: [],
      backendProcesses: [],
      plan: { ...defaultPlan },
      continuation: {
        enabled: config.continuable === true,
        available: false,
        updatedAt: config.continuable === true ? now : null,
      },
      errors: [],
      error: null,
    };
    this.#sessions.set(sessionId, snapshot);
    this.#configs.set(sessionId, config);
    this.#events.set(sessionId, []);
    return structuredClone(snapshot);
  }

  createHydrated(
    sessionId: SessionId,
    config: AiSessionConfig,
    transcript: readonly AiTranscriptEntry[],
    toolCalls: readonly AiToolCall[] = [],
    agentFrameworkSessionDir: string | null = null
  ): AiSessionSnapshot {
    this.create(sessionId, config);
    this.update(sessionId, (current) => {
      current.transcript = transcript.map((entry) => structuredClone(entry));
      current.toolCalls = toolCalls.map((toolCall) => structuredClone(toolCall));
      current.agentFrameworkSessionDir = agentFrameworkSessionDir;
    });
    return required(this.get(sessionId));
  }

  delete(sessionId: SessionId): void {
    this.#sessions.delete(sessionId);
    this.#configs.delete(sessionId);
    this.#events.delete(sessionId);
  }

  get(sessionId: SessionId): AiSessionSnapshot | undefined {
    const snapshot = this.#sessions.get(sessionId);
    if (snapshot) this.refreshAgentFrameworkSessionDir(snapshot);
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  getConfig(sessionId: SessionId): AiSessionConfig | undefined {
    return this.#configs.get(sessionId);
  }

  eventsSince(sessionId: SessionId, afterSeq: AiEventSeq): AiEvent[] {
    return (this.#events.get(sessionId) ?? []).filter((event) => event.seq > afterSeq).map((event) => structuredClone(event));
  }

  recordEvent(sessionId: SessionId, event: AiEvent): AiEvent {
    let recordedEvent = structuredClone(event);
    this.update(sessionId, (snapshot) => {
      this.refreshAgentFrameworkSessionDir(snapshot);
      recordedEvent = withEventMetadata(snapshot, recordedEvent);
      snapshot.lastEventSeq = event.seq;
    });
    const recorded = recordedEvent.type === "sessionUpdated"
      ? { ...recordedEvent, snapshot: required(this.get(sessionId)) }
      : recordedEvent;
    this.#events.get(sessionId)?.push(structuredClone(recorded));
    return structuredClone(recorded);
  }

  nextSeq(sessionId: SessionId): AiEventSeq {
    return (this.#sessions.get(sessionId)?.lastEventSeq ?? 0) + 1;
  }

  setStatus(sessionId: SessionId, status: AiSessionStatus, error: AiErrorInfo | null = null): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.status = status;
      snapshot.error = error;
      if (error) snapshot.errors.push(error);
    });
  }

  setPlan(sessionId: SessionId, plan: AiPlanState): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.plan = { ...plan };
    });
  }

  setContinuation(sessionId: SessionId, continuation: AiContinuationState): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.continuation = { ...continuation };
    });
  }

  appendMessage(
    sessionId: SessionId,
    input: {
      id: AiMessageId;
      turnId: TurnId | null;
      role: AiMessageRole;
      content: AiToolOutputBlock | string;
      status: AiMessageStatus;
      createdAt: string;
      usage?: TokenUsage | null;
    }
  ): AiTranscriptEntry {
    let entry: AiTranscriptEntry | undefined;
    this.update(sessionId, (snapshot) => {
      const text = typeof input.content === "string" ? input.content : "";
      entry = {
        id: input.id,
        sequenceId: null,
        turnId: input.turnId,
        role: input.role,
        content: text ? [{ type: "text", text }] : [],
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: input.status === "streaming" ? null : input.createdAt,
        usage: input.usage ?? null,
      };
      snapshot.transcript.push(entry);
    });
    return structuredClone(required(entry));
  }

  appendMessageDelta(sessionId: SessionId, id: AiMessageId, delta: string, now: string): AiTranscriptEntry {
    return this.appendContentDelta(sessionId, id, "text", delta, now);
  }

  appendErrorMessage(
    sessionId: SessionId,
    input: {
      id: AiMessageId;
      turnId: TurnId | null;
      message: string;
      metadata?: AiMetadata;
      createdAt: string;
    }
  ): AiTranscriptEntry {
    let entry: AiTranscriptEntry | undefined;
    this.update(sessionId, (snapshot) => {
      entry = {
        id: input.id,
        sequenceId: null,
        turnId: input.turnId,
        role: "tool",
        content: [{
          type: "error",
          message: input.message,
          ...(input.metadata ? { metadata: input.metadata } : {}),
        }],
        status: "failed",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
        completedAt: input.createdAt,
        usage: null,
      };
      snapshot.transcript.push(entry);
    });
    return structuredClone(required(entry));
  }

  appendReasoningDelta(sessionId: SessionId, id: AiMessageId, delta: string, now: string): AiTranscriptEntry {
    return this.appendContentDelta(sessionId, id, "reasoning", delta, now);
  }

  private appendContentDelta(
    sessionId: SessionId,
    id: AiMessageId,
    blockType: Extract<AiContentBlock["type"], "text" | "reasoning">,
    delta: string,
    now: string
  ): AiTranscriptEntry {
    let entry: AiTranscriptEntry | undefined;
    this.update(sessionId, (snapshot) => {
      const target = requireEntry(snapshot.transcript.find((item) => item.id === id), id);
      const last = target.content.at(-1);
      if (last?.type === blockType) {
        last.text += delta;
      } else {
        target.content.push({ type: blockType, text: delta });
      }
      target.updatedAt = now;
      entry = target;
    });
    return structuredClone(required(entry));
  }

  completeMessage(
    sessionId: SessionId,
    id: AiMessageId,
    now: string,
    status: Exclude<AiMessageStatus, "streaming">,
    usage: TokenUsage | null,
    content?: string
  ): AiTranscriptEntry {
    let entry: AiTranscriptEntry | undefined;
    this.update(sessionId, (snapshot) => {
      const target = requireEntry(snapshot.transcript.find((item) => item.id === id), id);
      if (content !== undefined) {
        const textIndex = target.content.findIndex((block) => block.type === "text");
        if (textIndex >= 0) {
          target.content = target.content.filter((block, index) => block.type !== "text" || index === textIndex);
          if (content) {
            target.content[textIndex] = { type: "text", text: content };
          } else {
            target.content.splice(textIndex, 1);
          }
        } else if (content) {
          target.content.push({ type: "text", text: content });
        }
      }
      target.status = status;
      target.updatedAt = now;
      target.completedAt = now;
      target.usage = usage;
      entry = target;
    });
    return structuredClone(required(entry));
  }

  createTool(
    sessionId: SessionId,
    input: {
      id: ToolCallId;
      turnId: TurnId;
      name: string;
      summary: AiToolInputSummary;
      metadata?: AiMetadata;
      now: string;
    }
  ): AiToolCall {
    let tool: AiToolCall | undefined;
    this.update(sessionId, (snapshot) => {
      tool = {
        id: input.id,
        turnId: input.turnId,
        name: input.name,
        input: input.summary,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        status: "created",
        wait: null,
        output: [],
        result: null,
        processId: null,
        progress: null,
        elapsedMs: null,
        createdAt: input.now,
        updatedAt: input.now,
        completedAt: null,
      };
      snapshot.toolCalls.push(tool);
    });
    return structuredClone(required(tool));
  }

  updateTool(
    sessionId: SessionId,
    id: ToolCallId,
    now: string,
    update: Partial<Pick<AiToolCall, "status" | "wait" | "progress" | "elapsedMs" | "processId">> & {
      metadata?: AiMetadata;
      output?: AiToolOutputBlock[];
      result?: AiToolResult | null;
    }
  ): AiToolCall {
    let tool: AiToolCall | undefined;
    this.update(sessionId, (snapshot) => {
      const target = requireEntry(snapshot.toolCalls.find((item) => item.id === id), id);
      const { output, result, metadata, ...fields } = update;
      Object.assign(target, fields);
      if (metadata) target.metadata = mergeMetadata(target.metadata, metadata);
      if (output) target.output = mergeOutput(target.output, output);
      if (result !== undefined) {
        target.result = result && shouldAttachAccumulatedOutput(result)
          ? { ...result, output: target.output.length > 0 ? target.output : result.output }
          : result;
      }
      target.updatedAt = now;
      if (isTerminalToolStatus(target.status)) target.completedAt = now;
      tool = target;
    });
    return structuredClone(required(tool));
  }

  createBackendProcess(
    sessionId: SessionId,
    input: {
      id: AiBackendProcessId;
      turnId: TurnId;
      title: string;
      cancellable: boolean;
      now: string;
    }
  ): AiBackendProcess {
    let process: AiBackendProcess | undefined;
    this.update(sessionId, (snapshot) => {
      process = {
        id: input.id,
        turnId: input.turnId,
        title: input.title,
        status: "created",
        progress: null,
        output: [],
        error: null,
        cancellable: input.cancellable,
        elapsedMs: null,
        createdAt: input.now,
        updatedAt: input.now,
        completedAt: null,
      };
      snapshot.backendProcesses.push(process);
    });
    return structuredClone(required(process));
  }

  updateBackendProcess(
    sessionId: SessionId,
    id: AiBackendProcessId,
    now: string,
    update: Partial<Pick<AiBackendProcess, "status" | "progress" | "elapsedMs" | "error">> & {
      output?: AiToolOutputBlock[];
    }
  ): AiBackendProcess {
    let process: AiBackendProcess | undefined;
    this.update(sessionId, (snapshot) => {
      const target = requireEntry(snapshot.backendProcesses.find((item) => item.id === id), id);
      const { output, ...fields } = update;
      Object.assign(target, fields);
      if (output) target.output = mergeOutput(target.output, output);
      target.updatedAt = now;
      if (["completed", "failed", "cancelled"].includes(target.status)) target.completedAt = now;
      process = target;
    });
    return structuredClone(required(process));
  }

  cancelActiveOperations(sessionId: SessionId, turnId: TurnId, now: string): {
    tools: AiToolCall[];
    processes: AiBackendProcess[];
  } {
    const tools: AiToolCall[] = [];
    const processes: AiBackendProcess[] = [];
    this.update(sessionId, (snapshot) => {
      for (const tool of snapshot.toolCalls) {
        if (tool.turnId === turnId && !isTerminalToolStatus(tool.status)) {
          tool.status = "cancelled";
          tool.wait = null;
          tool.progress = null;
          tool.elapsedMs = null;
          tool.updatedAt = now;
          tool.completedAt = now;
          tool.result = { state: "cancelled", output: tool.output, error: null };
          tools.push(structuredClone(tool));
        }
      }
      for (const process of snapshot.backendProcesses) {
        if (process.turnId === turnId && !["completed", "failed", "cancelled"].includes(process.status)) {
          process.status = "cancelled";
          process.progress = null;
          process.elapsedMs = null;
          process.updatedAt = now;
          process.completedAt = now;
          processes.push(structuredClone(process));
        }
      }
    });
    return { tools, processes };
  }

  update(sessionId: SessionId, f: (snapshot: AiSessionSnapshot) => void): AiSessionSnapshot {
    const snapshot = this.#sessions.get(sessionId);
    if (!snapshot) throw new Error(`Unknown AI session: ${sessionId}`);
    f(snapshot);
    snapshot.revision = (snapshot.revision + 1) as AiSnapshotRevision;
    return structuredClone(snapshot);
  }

  private refreshAgentFrameworkSessionDir(snapshot: AiSessionSnapshot): void {
    if (snapshot.agentFrameworkSessionDir || !snapshot.workingDir) return;
    snapshot.agentFrameworkSessionDir =
      resolveSessionTranscriptPathForProject(snapshot.workingDir)?.sessionDir ?? null;
  }
}

function withEventMetadata(snapshot: AiSessionSnapshot, event: AiEvent): AiEvent {
  if (event.type !== "messageCreated" && event.type !== "messageCompleted") {
    return event;
  }
  const message = assignMessageSequenceId(snapshot, event.message, event.seq);
  return { ...event, message };
}

function assignMessageSequenceId(
  snapshot: AiSessionSnapshot,
  message: AiTranscriptEntry,
  sequenceId: AiEventSeq
): AiTranscriptEntry {
  const target = snapshot.transcript.find((entry) => entry.id === message.id);
  const value = target?.sequenceId ?? message.sequenceId ?? sequenceId;
  if (target) target.sequenceId = target.sequenceId ?? value;
  return { ...message, sequenceId: value };
}

function isTerminalToolStatus(status: AiToolStatus): boolean {
  return ["completed", "failed", "cancelled", "denied", "unsupported"].includes(status);
}

function shouldAttachAccumulatedOutput(result: AiToolResult): boolean {
  return result.state !== "movedToProcess";
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be present");
  return value;
}

function requireEntry<T>(value: T | undefined, id: string): T {
  if (!value) throw new Error(`Unknown AI timeline item: ${id}`);
  return value;
}

function mergeOutput(existing: AiToolOutputBlock[], incoming: AiToolOutputBlock[]): AiToolOutputBlock[] {
  if (incoming.length === 0) return existing;
  if (startsWithBlocks(incoming, existing)) return [...incoming];
  if (startsWithBlocks(existing, incoming)) return existing;
  return [...existing, ...incoming];
}

function mergeMetadata(existing: AiMetadata | undefined, incoming: AiMetadata): AiMetadata {
  return { ...(existing ?? {}), ...incoming };
}

function startsWithBlocks(value: AiToolOutputBlock[], prefix: AiToolOutputBlock[]): boolean {
  if (prefix.length > value.length) return false;
  return prefix.every((item, index) => JSON.stringify(item) === JSON.stringify(value[index]));
}
