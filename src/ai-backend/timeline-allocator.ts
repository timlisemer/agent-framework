import type {
  AiBackendProcess,
  AiBackendProcessId,
  AiMessageId,
  AiSessionSnapshot,
  AiTimelineSeq,
  AiToolCall,
  AiTranscriptEntry,
  ToolCallId,
} from "../ai-protocol/index.js";

export type HydratableTranscriptEntry = Omit<AiTranscriptEntry, "sequenceId"> & {
  sequenceId?: AiTimelineSeq | null;
};

export type HydratableToolCall = Omit<AiToolCall, "sequenceId"> & {
  sequenceId?: AiTimelineSeq | null;
};

export class AiTimelineInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiTimelineInvariantError";
  }
}

type HydratedTimeline = {
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
};

type SequenceCandidate =
  | { kind: "message"; index: number; inputOrder: number }
  | { kind: "tool"; index: number; inputOrder: number };

export class TimelineAllocator {
  #messageCounter = 0;
  #toolCounter = 0;
  #processCounter = 0;
  #lastTimelineSeq = 0;

  get lastTimelineSeq(): AiTimelineSeq {
    return this.#lastTimelineSeq as AiTimelineSeq;
  }

  nextMessageId(): AiMessageId {
    return `message-${++this.#messageCounter}`;
  }

  nextToolId(): ToolCallId {
    return `tool-${++this.#toolCounter}`;
  }

  nextProcessId(): AiBackendProcessId {
    return `process-${++this.#processCounter}`;
  }

  nextTimelineSeq(): AiTimelineSeq {
    this.#lastTimelineSeq += 1;
    return this.#lastTimelineSeq as AiTimelineSeq;
  }

  rememberTimelineSeq(sequenceId: AiTimelineSeq): void {
    assertTimelineSeq(sequenceId, "timeline sequence id");
    if (sequenceId > this.#lastTimelineSeq) this.#lastTimelineSeq = sequenceId;
  }

  canonicalizeHydrated(input: {
    transcript: readonly HydratableTranscriptEntry[];
    toolCalls?: readonly HydratableToolCall[];
    backendProcesses?: readonly AiBackendProcess[];
    lastTimelineSeq?: AiTimelineSeq;
  }): HydratedTimeline {
    const transcript = input.transcript.map((entry) => structuredClone(entry));
    const toolCalls = (input.toolCalls ?? []).map((toolCall) => structuredClone(toolCall));
    const backendProcesses = input.backendProcesses ?? [];

    seedPublicIdCounters(this, transcript, toolCalls, backendProcesses);
    assertUniqueIds("message", transcript.map((entry) => entry.id));
    assertUniqueIds("tool call", toolCalls.map((toolCall) => toolCall.id));
    assertUniqueIds("backend process", backendProcesses.map((process) => process.id));
    if (input.lastTimelineSeq !== undefined) {
      if (!Number.isInteger(input.lastTimelineSeq) || input.lastTimelineSeq < 0) {
        throw new AiTimelineInvariantError(`Invalid last timeline sequence id: ${input.lastTimelineSeq}`);
      }
      if (input.lastTimelineSeq > 0) this.rememberTimelineSeq(input.lastTimelineSeq);
    }

    const seenSequences = new Set<AiTimelineSeq>();
    const missing: SequenceCandidate[] = [];
    let inputOrder = 0;

    transcript.forEach((entry, index) => {
      inputOrder += 1;
      const sequenceId = entry.sequenceId;
      if (sequenceId === null || sequenceId === undefined) {
        missing.push({ kind: "message", index, inputOrder });
        return;
      }
      rememberVisibleSequence(seenSequences, sequenceId);
      this.rememberTimelineSeq(sequenceId);
    });

    toolCalls.forEach((toolCall, index) => {
      inputOrder += 1;
      const sequenceId = toolCall.sequenceId;
      if (sequenceId === null || sequenceId === undefined) {
        missing.push({ kind: "tool", index, inputOrder });
        return;
      }
      rememberVisibleSequence(seenSequences, sequenceId);
      this.rememberTimelineSeq(sequenceId);
    });

    missing.sort(compareSequenceCandidates);
    for (const candidate of missing) {
      const sequenceId = this.nextTimelineSeq();
      rememberVisibleSequence(seenSequences, sequenceId);
      if (candidate.kind === "message") {
        transcript[candidate.index] = { ...transcript[candidate.index], sequenceId };
      } else {
        toolCalls[candidate.index] = { ...toolCalls[candidate.index], sequenceId };
      }
    }

    return {
      transcript: transcript.map((entry) => requireStrictTranscriptEntry(entry)),
      toolCalls: toolCalls.map((toolCall) => requireStrictToolCall(toolCall)),
    };
  }

  validateSnapshot(snapshot: AiSessionSnapshot): void {
    seedPublicIdCounters(this, snapshot.transcript, snapshot.toolCalls, snapshot.backendProcesses);
    assertUniqueIds("message", snapshot.transcript.map((entry) => entry.id));
    assertUniqueIds("tool call", snapshot.toolCalls.map((toolCall) => toolCall.id));
    assertUniqueIds("backend process", snapshot.backendProcesses.map((process) => process.id));
    assertStrictTimelineRows(snapshot.transcript, snapshot.toolCalls);
    for (const entry of snapshot.transcript) this.rememberTimelineSeq(entry.sequenceId);
    for (const toolCall of snapshot.toolCalls) this.rememberTimelineSeq(toolCall.sequenceId);
  }

  seedMessageId(id: AiMessageId): void {
    this.#messageCounter = Math.max(this.#messageCounter, numericSuffix(id, "message"));
  }

  seedToolId(id: ToolCallId): void {
    this.#toolCounter = Math.max(this.#toolCounter, numericSuffix(id, "tool"));
  }

  seedProcessId(id: AiBackendProcessId): void {
    this.#processCounter = Math.max(this.#processCounter, numericSuffix(id, "process"));
  }
}

export function assertStrictTimelineRows(
  transcript: readonly AiTranscriptEntry[],
  toolCalls: readonly AiToolCall[]
): void {
  const seenSequences = new Set<AiTimelineSeq>();
  for (const entry of transcript) {
    rememberVisibleSequence(seenSequences, entry.sequenceId);
  }
  for (const toolCall of toolCalls) {
    rememberVisibleSequence(seenSequences, toolCall.sequenceId);
  }
}

function requireStrictTranscriptEntry(entry: HydratableTranscriptEntry): AiTranscriptEntry {
  if (entry.sequenceId === null || entry.sequenceId === undefined) {
    throw new AiTimelineInvariantError(`Transcript entry ${entry.id} is missing a timeline sequence id.`);
  }
  return { ...entry, sequenceId: entry.sequenceId };
}

function requireStrictToolCall(toolCall: HydratableToolCall): AiToolCall {
  if (toolCall.sequenceId === null || toolCall.sequenceId === undefined) {
    throw new AiTimelineInvariantError(`Tool call ${toolCall.id} is missing a timeline sequence id.`);
  }
  return { ...toolCall, sequenceId: toolCall.sequenceId };
}

function seedPublicIdCounters(
  allocator: TimelineAllocator,
  transcript: readonly { id: AiMessageId }[],
  toolCalls: readonly { id: ToolCallId }[],
  backendProcesses: readonly { id: AiBackendProcessId }[]
): void {
  for (const entry of transcript) allocator.seedMessageId(entry.id);
  for (const toolCall of toolCalls) allocator.seedToolId(toolCall.id);
  for (const process of backendProcesses) allocator.seedProcessId(process.id);
}

function assertUniqueIds(kind: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new AiTimelineInvariantError(`Duplicate ${kind} id in AI timeline: ${id}`);
    seen.add(id);
  }
}

function rememberVisibleSequence(seen: Set<AiTimelineSeq>, sequenceId: AiTimelineSeq): void {
  assertTimelineSeq(sequenceId, "visible timeline sequence id");
  if (seen.has(sequenceId)) {
    throw new AiTimelineInvariantError(`Duplicate visible AI timeline sequence id: ${sequenceId}`);
  }
  seen.add(sequenceId);
}

function assertTimelineSeq(value: number, label: string): asserts value is AiTimelineSeq {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AiTimelineInvariantError(`Invalid ${label}: ${value}`);
  }
}

function numericSuffix(id: string, prefix: string): number {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(id);
  return match ? Number(match[1]) : 0;
}

function compareSequenceCandidates(left: SequenceCandidate, right: SequenceCandidate): number {
  return left.inputOrder - right.inputOrder;
}
