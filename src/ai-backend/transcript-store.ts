import type {
  AiContinuationState,
  AiErrorInfo,
  AiEvent,
  AiEventSeq,
  AiPlanState,
  AiProviderMetadataState,
  AiSessionConfig,
  AiSessionSnapshot,
  AiSessionStatus,
  AiSnapshotRevision,
  AiTimelineSeq,
  AiTranscriptEntry,
  TurnId,
  SessionId,
} from "../ai-protocol/index.js";
import { resolveSessionTranscriptPathForProject } from "../utils/paths.js";
import {
  TimelineAllocator,
  type HydratableToolCall,
  type HydratableTranscriptEntry,
} from "./timeline-allocator.js";
import { createDefaultProviderMetadata, mergeProviderMetadata } from "./provider-metadata.js";
import { safeTimelineId } from "./timeline-id.js";
import {
  isActiveBackendProcessStatus,
  isActiveMessageStatus,
  isActiveSessionStatus,
  isActiveToolStatus,
  isDanglingMessageStatus,
  isDanglingToolStatus,
} from "./timeline-status.js";

type PendingUserMessage = {
  entry: HydratableTranscriptEntry;
  textKey: string;
  baselineMatchingUserCount: number;
};

const defaultPlan: AiPlanState = {
  mode: "disabled",
  planText: null,
  approved: false,
};

export const defaultProviderMetadata: AiProviderMetadataState = createDefaultProviderMetadata();

export class TranscriptStore {
  readonly #sessions = new Map<SessionId, AiSessionSnapshot>();
  readonly #configs = new Map<SessionId, AiSessionConfig>();
  readonly #events = new Map<SessionId, AiEvent[]>();
  readonly #allocators = new Map<SessionId, TimelineAllocator>();
  readonly #pendingUserMessages = new Map<SessionId, PendingUserMessage[]>();

  create(
    sessionId: SessionId,
    config: AiSessionConfig,
    allocator: TimelineAllocator = new TimelineAllocator(),
    provider: AiProviderMetadataState = defaultProviderMetadata
  ): AiSessionSnapshot {
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
      provider: structuredClone(provider),
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
    this.#allocators.set(sessionId, allocator);
    this.#pendingUserMessages.set(sessionId, []);
    return structuredClone(snapshot);
  }

  createHydrated(
    sessionId: SessionId,
    config: AiSessionConfig,
    transcript: readonly HydratableTranscriptEntry[],
    toolCalls: readonly HydratableToolCall[] = [],
    options: {
      agentFrameworkSessionDir?: string | null;
      lastEventSeq?: AiEventSeq;
      lastTimelineSeq?: AiTimelineSeq;
      provider?: AiProviderMetadataState;
    } = {}
  ): AiSessionSnapshot {
    const allocator = new TimelineAllocator();
    const hydrated = allocator.canonicalizeHydrated({
      transcript,
      toolCalls,
      lastTimelineSeq: options.lastTimelineSeq,
    });
    this.create(sessionId, config, allocator, options.provider);
    this.update(sessionId, (current) => {
      current.transcript = hydrated.transcript.map((entry) => structuredClone(entry));
      current.toolCalls = hydrated.toolCalls.map((toolCall) => structuredClone(toolCall));
      current.agentFrameworkSessionDir = options.agentFrameworkSessionDir ?? null;
      current.lastEventSeq = options.lastEventSeq ?? 0;
    });
    return required(this.get(sessionId));
  }

  delete(sessionId: SessionId): void {
    this.#sessions.delete(sessionId);
    this.#configs.delete(sessionId);
    this.#events.delete(sessionId);
    this.#allocators.delete(sessionId);
    this.#pendingUserMessages.delete(sessionId);
  }

  get(sessionId: SessionId): AiSessionSnapshot | undefined {
    const snapshot = this.#sessions.get(sessionId);
    if (snapshot) {
      this.refreshAgentFrameworkSessionDir(snapshot);
      this.allocator(sessionId).validateSnapshot(snapshot);
    }
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  allocator(sessionId: SessionId): TimelineAllocator {
    const allocator = this.#allocators.get(sessionId);
    if (!allocator) throw new Error(`Unknown AI session allocator: ${sessionId}`);
    return allocator;
  }

  getConfig(sessionId: SessionId): AiSessionConfig | undefined {
    return this.#configs.get(sessionId);
  }

  eventsSince(sessionId: SessionId, afterSeq: AiEventSeq): AiEvent[] {
    return (this.#events.get(sessionId) ?? []).filter((event) => event.seq > afterSeq).map((event) => structuredClone(event));
  }

  recordEvent(sessionId: SessionId, event: AiEvent): { event: AiEvent; snapshot: AiSessionSnapshot } {
    const snapshot = this.update(sessionId, (snapshot) => {
      this.refreshAgentFrameworkSessionDir(snapshot);
      snapshot.lastEventSeq = event.seq;
    });
    const recorded = this.withEventMetadata(snapshot, structuredClone(event));
    this.#events.get(sessionId)?.push(structuredClone(recorded));
    return {
      event: structuredClone(recorded),
      snapshot,
    };
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

  setProvider(sessionId: SessionId, provider: Partial<AiProviderMetadataState>): AiSessionSnapshot {
    return this.update(sessionId, (snapshot) => {
      snapshot.provider = mergeProviderMetadata(snapshot.provider, provider);
    });
  }

  addPendingUserMessage(
    sessionId: SessionId,
    input: { turnId: TurnId; content: string; createdAt?: string }
  ): AiSessionSnapshot {
    const now = input.createdAt ?? new Date().toISOString();
    const textKey = normalizeTranscriptText(input.content);
    const id = `message-pending-${safeTimelineId(input.turnId, "turn")}`;
    return this.update(sessionId, (snapshot) => {
      const entry: AiTranscriptEntry = {
        id,
        sequenceId: this.allocator(sessionId).nextTimelineSeq(),
        turnId: input.turnId,
        role: "user",
        content: [{ type: "text", text: input.content }],
        status: "pending",
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        usage: null,
      };
      const pending = (this.#pendingUserMessages.get(sessionId) ?? [])
        .filter((message) => message.entry.id !== id);
      pending.push({
        entry: structuredClone(entry),
        textKey,
        baselineMatchingUserCount: countMatchingCompletedUserMessages(snapshot.transcript, textKey),
      });
      this.#pendingUserMessages.set(sessionId, pending);
      snapshot.transcript = [
        ...snapshot.transcript.filter((message) => message.id !== id),
        structuredClone(entry),
      ];
    });
  }

  recordTerminalTurn(
    sessionId: SessionId,
    input: {
      turnId: TurnId;
      status: "failed" | "cancelled";
      error: AiErrorInfo;
      createdAt?: string;
    }
  ): AiSessionSnapshot {
    const now = input.createdAt ?? new Date().toISOString();
    const terminalId = `message-terminal-${safeTimelineId(input.turnId, "turn")}-${input.status}`;
    return this.update(sessionId, (snapshot) => {
      for (const entry of snapshot.transcript) {
        if (entry.turnId === input.turnId && isActiveMessageStatus(entry.status)) {
          entry.status = input.status;
          entry.updatedAt = now;
          entry.completedAt = now;
        }
      }

      const pending = this.#pendingUserMessages.get(sessionId) ?? [];
      this.#pendingUserMessages.set(sessionId, pending.map((message) => {
        if (message.entry.turnId !== input.turnId || !isActiveMessageStatus(message.entry.status)) {
          return message;
        }
        return {
          ...message,
          entry: {
            ...message.entry,
            status: input.status,
            updatedAt: now,
            completedAt: now,
          },
        };
      }));

      for (const toolCall of snapshot.toolCalls) {
        if (toolCall.turnId === input.turnId && isActiveToolStatus(toolCall.status)) {
          toolCall.status = input.status;
          toolCall.wait = null;
          toolCall.progress = null;
          toolCall.updatedAt = now;
          toolCall.completedAt = now;
          toolCall.result = {
            state: input.status,
            output: toolCall.output,
            error: input.status === "failed" ? input.error : null,
          };
        }
      }

      for (const process of snapshot.backendProcesses) {
        if (process.turnId === input.turnId && isActiveBackendProcessStatus(process.status)) {
          process.status = input.status;
          process.progress = null;
          process.cancellable = false;
          process.updatedAt = now;
          process.completedAt = now;
          process.error = input.status === "failed" ? input.error : null;
        }
      }

      const existingIndex = snapshot.transcript.findIndex((entry) => entry.id === terminalId);
      const existing = existingIndex >= 0 ? snapshot.transcript[existingIndex] : null;
      const terminalEntry: AiTranscriptEntry = {
        id: terminalId,
        sequenceId: existing?.sequenceId ?? this.allocator(sessionId).nextTimelineSeq(),
        turnId: input.turnId,
        role: "assistant",
        content: [terminalErrorBlock(input.error)],
        status: input.status,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        completedAt: now,
        usage: null,
      };
      if (existingIndex >= 0) {
        snapshot.transcript[existingIndex] = terminalEntry;
      } else {
        snapshot.transcript = [
          ...snapshot.transcript,
          terminalEntry,
        ];
      }
    });
  }

  recordCompletedTurn(
    sessionId: SessionId,
    input: { turnId: TurnId; createdAt?: string }
  ): AiSessionSnapshot | null {
    const snapshot = required(this.#sessions.get(sessionId));
    const pending = this.#pendingUserMessages.get(sessionId) ?? [];
    const hasPendingTranscriptEntry = snapshot.transcript.some((entry) =>
      entry.turnId === input.turnId && isActiveMessageStatus(entry.status)
    );
    const hasPendingRecord = pending.some((message) =>
      message.entry.turnId === input.turnId && isActiveMessageStatus(message.entry.status)
    );
    if (!hasPendingTranscriptEntry && !hasPendingRecord) return null;

    const now = input.createdAt ?? new Date().toISOString();
    return this.update(sessionId, (snapshot) => {
      for (const entry of snapshot.transcript) {
        if (entry.turnId === input.turnId && isActiveMessageStatus(entry.status)) {
          entry.status = "completed";
          entry.updatedAt = now;
          entry.completedAt = now;
        }
      }
      this.#pendingUserMessages.set(
        sessionId,
        pending.filter((message) => message.entry.turnId !== input.turnId)
      );
    });
  }

  replaceTimeline(
    sessionId: SessionId,
    transcript: readonly HydratableTranscriptEntry[],
    toolCalls: readonly HydratableToolCall[],
    options: {
      agentFrameworkSessionDir?: string | null;
      provider?: Partial<AiProviderMetadataState>;
    } = {}
  ): AiSessionSnapshot {
    const { transcript: mergedTranscript, pending } = this.mergePendingUserMessages(sessionId, transcript, toolCalls);
    const hydrated = this.allocator(sessionId).canonicalizeHydrated({ transcript: mergedTranscript, toolCalls });
    const snapshot = this.update(sessionId, (snapshot) => {
      snapshot.transcript = hydrated.transcript.map((entry) => structuredClone(entry));
      snapshot.toolCalls = hydrated.toolCalls.map((toolCall) => structuredClone(toolCall));
      if (options.agentFrameworkSessionDir !== undefined) {
        snapshot.agentFrameworkSessionDir = options.agentFrameworkSessionDir;
      }
      if (options.provider) {
        snapshot.provider = mergeProviderMetadata(snapshot.provider, options.provider);
      }
    });
    const hydratedById = new Map(hydrated.transcript.map((entry) => [entry.id, entry]));
    this.#pendingUserMessages.set(sessionId, pending.flatMap((message) => {
      const hydratedEntry = hydratedById.get(message.entry.id);
      return hydratedEntry
        ? [{ ...message, entry: structuredClone(hydratedEntry) }]
        : [];
    }));
    return snapshot;
  }

  update(sessionId: SessionId, f: (snapshot: AiSessionSnapshot) => void): AiSessionSnapshot {
    const snapshot = this.#sessions.get(sessionId);
    if (!snapshot) throw new Error(`Unknown AI session: ${sessionId}`);
    f(snapshot);
    normalizeInactiveSnapshot(snapshot);
    this.#pendingUserMessages.set(sessionId, normalizeInactivePendingUserMessages(
      this.#pendingUserMessages.get(sessionId) ?? [],
      snapshot.status
    ));
    this.allocator(sessionId).validateSnapshot(snapshot);
    snapshot.revision = (snapshot.revision + 1) as AiSnapshotRevision;
    return structuredClone(snapshot);
  }

  private withEventMetadata(snapshot: AiSessionSnapshot, event: AiEvent): AiEvent {
    switch (event.type) {
      case "sessionUpdated":
        return { ...event, snapshot: structuredClone(snapshot) };
      default:
        return event;
    }
  }

  private refreshAgentFrameworkSessionDir(snapshot: AiSessionSnapshot): void {
    if (snapshot.agentFrameworkSessionDir || !snapshot.workingDir) return;
    snapshot.agentFrameworkSessionDir =
      resolveSessionTranscriptPathForProject(snapshot.workingDir)?.sessionDir ?? null;
  }

  private mergePendingUserMessages(
    sessionId: SessionId,
    transcript: readonly HydratableTranscriptEntry[],
    toolCalls: readonly HydratableToolCall[]
  ): { transcript: HydratableTranscriptEntry[]; pending: PendingUserMessage[] } {
    const pending = this.unconfirmedPendingUserMessages(sessionId, transcript);
    if (pending.length === 0) {
      return { transcript: transcript.map((entry) => structuredClone(entry)), pending };
    }

    const incomingIds = new Set(transcript.map((entry) => entry.id));
    const usedSequences = new Set<AiTimelineSeq>();
    for (const entry of transcript) {
      if (entry.sequenceId !== null && entry.sequenceId !== undefined) usedSequences.add(entry.sequenceId);
    }
    for (const toolCall of toolCalls) {
      if (toolCall.sequenceId !== null && toolCall.sequenceId !== undefined) usedSequences.add(toolCall.sequenceId);
    }

    const pendingEntries = pending.flatMap((message) => {
      if (incomingIds.has(message.entry.id)) return [];
      const entry = structuredClone(message.entry);
      if (entry.sequenceId !== null && entry.sequenceId !== undefined && usedSequences.has(entry.sequenceId)) {
        entry.sequenceId = null;
      }
      if (entry.sequenceId !== null && entry.sequenceId !== undefined) usedSequences.add(entry.sequenceId);
      return [entry];
    });

    return {
      transcript: [
        ...transcript.map((entry) => structuredClone(entry)),
        ...pendingEntries,
      ],
      pending,
    };
  }

  private unconfirmedPendingUserMessages(
    sessionId: SessionId,
    transcript: readonly HydratableTranscriptEntry[]
  ): PendingUserMessage[] {
    const pending = this.#pendingUserMessages.get(sessionId) ?? [];
    if (pending.length === 0) return [];
    const incomingCounts = completedUserTextCounts(transcript);
    const confirmedCounts = new Map<string, number>();
    return pending.filter((message) => {
      const confirmedForText = confirmedCounts.get(message.textKey) ?? 0;
      const incomingCount = incomingCounts.get(message.textKey) ?? 0;
      const confirmed = incomingCount > message.baselineMatchingUserCount + confirmedForText;
      if (confirmed) confirmedCounts.set(message.textKey, confirmedForText + 1);
      return !confirmed;
    });
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected value to be present");
  return value;
}

function completedUserTextCounts(
  transcript: readonly HydratableTranscriptEntry[]
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of transcript) {
    if (entry.role !== "user" || entry.status === "pending" || isSyntheticMessage(entry)) continue;
    const textKey = normalizeTranscriptText(textFromTranscriptEntry(entry));
    counts.set(textKey, (counts.get(textKey) ?? 0) + 1);
  }
  return counts;
}

function countMatchingCompletedUserMessages(
  transcript: readonly HydratableTranscriptEntry[],
  textKey: string
): number {
  return completedUserTextCounts(transcript).get(textKey) ?? 0;
}

function textFromTranscriptEntry(entry: HydratableTranscriptEntry): string {
  return entry.content
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n");
}

function normalizeTranscriptText(text: string): string {
  return text.replace(/\r\n/g, "\n").trim();
}

function isSyntheticMessage(entry: HydratableTranscriptEntry): boolean {
  return entry.metadata?.agentFrameworkMessageKind === "synthetic";
}

function normalizeInactiveSnapshot(snapshot: AiSessionSnapshot): void {
  if (isActiveSessionStatus(snapshot.status)) return;
  const terminalStatus = snapshot.status === "error" ? "failed" : "cancelled";
  const error = terminalStatus === "failed" ? snapshot.error : null;
  const now = new Date().toISOString();
  for (const entry of snapshot.transcript) {
    if (!isDanglingMessageStatus(entry.status)) continue;
    entry.status = terminalStatus;
    entry.updatedAt = now;
    entry.completedAt = now;
  }
  for (const toolCall of snapshot.toolCalls) {
    if (!isDanglingToolStatus(toolCall.status)) continue;
    toolCall.status = terminalStatus;
    toolCall.wait = null;
    toolCall.progress = null;
    toolCall.updatedAt = now;
    toolCall.completedAt = now;
    toolCall.result = {
      state: terminalStatus,
      output: toolCall.output,
      error,
    };
  }
  for (const process of snapshot.backendProcesses) {
    if (!isActiveBackendProcessStatus(process.status)) continue;
    process.status = terminalStatus;
    process.progress = null;
    process.cancellable = false;
    process.updatedAt = now;
    process.completedAt = now;
    process.error = error;
  }
}

function normalizeInactivePendingUserMessages(
  pending: readonly PendingUserMessage[],
  status: AiSessionSnapshot["status"]
): PendingUserMessage[] {
  if (isActiveSessionStatus(status)) return pending.map((message) => structuredClone(message));
  const terminalStatus = status === "error" ? "failed" : "cancelled";
  const now = new Date().toISOString();
  return pending.map((message) => {
    if (!isDanglingMessageStatus(message.entry.status)) return structuredClone(message);
    return {
      ...message,
      entry: {
        ...message.entry,
        status: terminalStatus,
        updatedAt: now,
        completedAt: now,
      },
    };
  });
}

function terminalErrorBlock(error: AiErrorInfo): AiTranscriptEntry["content"][number] {
  return {
    type: "error",
    message: formatTerminalError(error),
    ...(error.metadata ? { metadata: error.metadata } : {}),
  };
}

function formatTerminalError(error: AiErrorInfo): string {
  return `${error.code}: ${error.message}${error.recoverable ? " (recoverable)" : ""}`;
}
