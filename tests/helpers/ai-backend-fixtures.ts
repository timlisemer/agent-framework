import type {
  AiBackendProcess,
  AiMetadata,
  AiTimelineSeq,
  AiToolCall,
  AiToolInputSummary,
  AiTranscriptEntry,
  AiWaitState,
  TokenUsage,
} from "../../src/ai-protocol/index.js";
import type {
  HydratableToolCall,
  HydratableTranscriptEntry,
} from "../../src/ai-backend/timeline-allocator.js";

const DEFAULT_CREATED_AT = "2026-06-20T10:00:00.000Z";

type TranscriptEntryFixtureInput = {
  id: string;
  sequenceId?: AiTimelineSeq | null;
  turnId?: string | null;
  role?: AiTranscriptEntry["role"];
  text?: string;
  content?: AiTranscriptEntry["content"];
  status?: AiTranscriptEntry["status"];
  metadata?: AiMetadata;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
  usage?: TokenUsage | null;
};

type ToolCallFixtureInput = {
  id: string;
  sequenceId?: AiTimelineSeq | null;
  turnId?: string;
  name?: string;
  input?: AiToolInputSummary;
  inputText?: string;
  status?: AiToolCall["status"];
  metadata?: AiMetadata;
  wait?: AiWaitState;
  output?: AiToolCall["output"];
  result?: AiToolCall["result"];
  processId?: AiToolCall["processId"];
  progress?: string | null;
  elapsedMs?: number | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
};

export function transcriptEntryFixture(input: TranscriptEntryFixtureInput & { sequenceId: AiTimelineSeq }): AiTranscriptEntry;
export function transcriptEntryFixture(input: TranscriptEntryFixtureInput): HydratableTranscriptEntry;
export function transcriptEntryFixture(input: TranscriptEntryFixtureInput): HydratableTranscriptEntry {
  const createdAt = input.createdAt ?? DEFAULT_CREATED_AT;
  return {
    id: input.id,
    ...(input.sequenceId !== undefined ? { sequenceId: input.sequenceId } : {}),
    turnId: input.turnId ?? null,
    role: input.role ?? "assistant",
    content: input.content ?? [{ type: "text", text: input.text ?? "hello" }],
    status: input.status ?? "completed",
    ...(input.metadata ? { metadata: input.metadata } : {}),
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    completedAt: input.completedAt === undefined ? createdAt : input.completedAt,
    usage: input.usage ?? null,
  };
}

export function toolCallFixture(input: ToolCallFixtureInput & { sequenceId: AiTimelineSeq }): AiToolCall;
export function toolCallFixture(input: ToolCallFixtureInput): HydratableToolCall;
export function toolCallFixture(input: ToolCallFixtureInput): HydratableToolCall {
  const createdAt = input.createdAt ?? DEFAULT_CREATED_AT;
  const output = input.output ?? [];
  return {
    id: input.id,
    ...(input.sequenceId !== undefined ? { sequenceId: input.sequenceId } : {}),
    turnId: input.turnId ?? "turn-1",
    name: input.name ?? "exec_command",
    input: input.input ?? { text: input.inputText ?? "git status --short" },
    status: input.status ?? "completed",
    ...(input.metadata ? { metadata: input.metadata } : {}),
    wait: input.wait ?? null,
    output,
    result: input.result === undefined ? { state: "completed", output, error: null } : input.result,
    processId: input.processId ?? null,
    progress: input.progress ?? null,
    elapsedMs: input.elapsedMs ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    completedAt: input.completedAt === undefined ? createdAt : input.completedAt,
  };
}

export function backendProcessFixture(input: {
  id: string;
  turnId?: string;
  title?: string;
  status?: AiBackendProcess["status"];
  progress?: string | null;
  output?: AiBackendProcess["output"];
  error?: AiBackendProcess["error"];
  cancellable?: boolean;
  elapsedMs?: number | null;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}): AiBackendProcess {
  const createdAt = input.createdAt ?? DEFAULT_CREATED_AT;
  return {
    id: input.id,
    turnId: input.turnId ?? "turn-1",
    title: input.title ?? "Process",
    status: input.status ?? "completed",
    progress: input.progress ?? null,
    output: input.output ?? [],
    error: input.error ?? null,
    cancellable: input.cancellable ?? false,
    elapsedMs: input.elapsedMs ?? null,
    createdAt,
    updatedAt: input.updatedAt ?? createdAt,
    completedAt: input.completedAt === undefined ? createdAt : input.completedAt,
  };
}
