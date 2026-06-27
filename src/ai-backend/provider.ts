import { parseTierName } from "../types.js";
import { resolveProvider, type ResolvedProvider } from "../utils/provider-config.js";
import {
  buildClaudeQueryOptions,
  createClaudeControlStreamState,
  createClaudeRuntimeHomeLease,
  mapClaudeControlStreamMessage,
  recordClaudePlanUpdate,
  resolveClaudeTranscriptBinding,
  sanitizeClaudeEnv,
  type ClaudeRuntimeHomeLease,
} from "../providers/claude-agent-runtime.js";
import {
  createCodexLiveSession,
  normalizeCodexAiUsage,
  resolveCodexTranscriptBinding,
} from "../providers/codex-agent-runtime.js";
import { PROVIDERS, PROVIDER_TYPES, providerKey } from "../providers/registry.js";
import { selectSdkRuntime } from "../providers/index.js";
import { optionalNumber } from "../utils/output.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import type { AiProviderMetadataState, AiSessionConfig, AiToolCall, AiToolDecision, TurnId } from "../ai-protocol/index.js";
import type { AiRuntimeEvent, AiRunTurnInput } from "./runtime-events.js";
import { DecisionBroker } from "./decision-broker.js";
import type { ResumeTarget } from "./session-history.js";
import type { TranscriptProjection } from "./transcript-runtime.js";
import { createTimelineSnapshotPublisher, emptyTranscriptProjection } from "./timeline-snapshot-publisher.js";
import { createDefaultProviderMetadata } from "./provider-metadata.js";

export { buildClaudeQueryOptions } from "../providers/claude-agent-runtime.js";

export interface AiProviderRunner {
  readonly resolvedProvider: ResolvedProvider;
  runTurn(input: AiRunTurnInput): AsyncIterable<AiRuntimeEvent>;
  submitToolDecision?(decision: AiToolDecision): Promise<void>;
  dispose?(): Promise<void> | void;
}

export class ResumeProviderMismatchError extends Error {
  constructor(targetProvider: ResumeTarget["provider"], configuredRuntime: ReturnType<typeof selectSdkRuntime>) {
    super(`Resume target provider ${targetProvider} is incompatible with configured SDK runtime ${configuredRuntime}.`);
    this.name = "ResumeProviderMismatchError";
  }
}

export function createProviderRunner(config: AiSessionConfig): AiProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  return createResolvedProviderRunner(resolvedProvider);
}

export function createResolvedProviderRunner(resolvedProvider: ResolvedProvider): AiProviderRunner {
  return providerRunnerFactory(selectSdkRuntime(resolvedProvider)).create(resolvedProvider);
}

export function createResumeProviderRunner(config: AiSessionConfig, target: ResumeTarget): AiProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  const configuredRuntime = selectSdkRuntime(resolvedProvider);
  if (configuredRuntime !== target.provider) {
    throw new ResumeProviderMismatchError(target.provider, configuredRuntime);
  }
  return providerRunnerFactory(configuredRuntime).resume(resolvedProvider, target);
}

export function resolveSessionProvider(config: AiSessionConfig): ResolvedProvider {
  const tier = parseTierName(config.model ?? undefined);
  return resolveProvider(tier, "sdk");
}

export function buildCodexTurnInput(config: AiSessionConfig, prompt: string): string {
  if (!config.systemPrompt) return prompt;
  return `System instructions:\n${config.systemPrompt}\n\nUser request:\n${prompt}`;
}

type ProviderRunnerFactory = {
  create(resolvedProvider: ResolvedProvider): AiProviderRunner;
  resume(resolvedProvider: ResolvedProvider, target: ResumeTarget): AiProviderRunner;
};

const PROVIDER_RUNNER_FACTORIES: Record<ReturnType<typeof selectSdkRuntime>, ProviderRunnerFactory> = {
  claude: {
    create: (resolvedProvider) => new ClaudeUiProvider(resolvedProvider),
    resume: (resolvedProvider, target) =>
      new ClaudeUiProvider(resolvedProvider, target.target.sessionId ?? target.nativeSessionId, target.transcriptPath),
  },
  codex: {
    create: (resolvedProvider) => new CodexUiProvider(resolvedProvider),
    resume: (resolvedProvider, target) =>
      new CodexUiProvider(resolvedProvider, target.target.threadId ?? target.nativeSessionId, target.transcriptPath),
  },
};

function providerRunnerFactory(runtime: ReturnType<typeof selectSdkRuntime>): ProviderRunnerFactory {
  return PROVIDER_RUNNER_FACTORIES[runtime];
}

export function providerMetadataForResolvedProvider(resolvedProvider: ResolvedProvider): AiProviderMetadataState {
  const definition = PROVIDERS[providerKey(resolvedProvider.type)];
  return createDefaultProviderMetadata({
    provider: resolvedProvider.type,
    runtime: selectSdkRuntime(resolvedProvider),
    model: resolvedProvider.modelId,
    displayModel: resolvedProvider.modelId,
    availableModels: Object.entries(definition.models).map(([tier, model]) => ({
      tier,
      id: model.id,
      displayName: model.id,
    })),
  });
}

class ClaudeUiProvider implements AiProviderRunner {
  #runtimeSessionRef: string | null = null;
  #resumeTranscriptPath: string | null = null;
  #runtimeHomeLease: ClaudeRuntimeHomeLease | null = null;
  readonly #decisions = new DecisionBroker();
  readonly #pendingApprovals = new Map<string, PendingToolApproval>();

  constructor(readonly resolvedProvider: ResolvedProvider, runtimeSessionRef: string | null = null, resumeTranscriptPath: string | null = null) {
    this.#runtimeSessionRef = runtimeSessionRef;
    this.#resumeTranscriptPath = resumeTranscriptPath;
  }

  async *runTurn(input: AiRunTurnInput): AsyncIterable<AiRuntimeEvent> {
    const { config, prompt, signal } = input;
    signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const queue = new RuntimeEventQueue();
    const env = sanitizeClaudeEnv(
      process.env,
      this.resolvedProvider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
    );
    const streamState = createClaudeControlStreamState(this.#runtimeSessionRef);
    let runtimeHomeRoot: string | null | undefined;
    const publisher = createTimelineSnapshotPublisher({
      adapterName: "claude",
      workingDir: config.workingDir,
      queue,
      nativeSessionId: () => this.#runtimeSessionRef,
      resolveTranscriptPath: () => resolveClaudeTranscriptBinding({
        runtimeHomeRoot,
        sessionId: this.#runtimeSessionRef,
        workingDir: config.workingDir,
        resumeTranscriptPath: this.#resumeTranscriptPath,
      }),
      signal,
      transformProjection: (projection) =>
        overlayPendingToolApprovals(projection, [...this.#pendingApprovals.values()], input.turnId),
      fallbackProjection: emptyTranscriptProjection,
    });

    const producer = (async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const runtimeHomeLease = config.continuable === true
        ? (this.#runtimeHomeLease ??= createClaudeRuntimeHomeLease({
            config,
            env,
            continuable: true,
          }))
        : createClaudeRuntimeHomeLease({
            config,
            env,
            continuable: false,
          });
      const runtimeHome = runtimeHomeLease.get();
      runtimeHomeRoot = runtimeHome.root;
      try {
        publisher.publishPolled();
        publisher.startPolling();
        const stream = query({
          prompt,
          options: buildClaudeQueryOptions(config, this.resolvedProvider, abortController, env, {
            canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; title?: string; decisionReason?: string }) => {
              const ref = options.toolUseID;
              if (toolName === "ExitPlanMode" && typeof toolInput.plan === "string" && recordClaudePlanUpdate(streamState, toolInput.plan)) {
                queue.push({ type: "plan.updated", state: { mode: "awaitingApproval", planText: toolInput.plan, approved: false } });
              }
              const decisionPromise = this.#decisions.waitForDecision(ref, options.signal);
              this.#pendingApprovals.set(ref, pendingToolApproval({
                toolUseId: ref,
                toolName,
                toolInput,
                turnId: input.turnId,
                waitReason: toolApprovalWaitReason(toolName, options),
              }));
              publisher.publishSnapshot();
              try {
                const decision = await decisionPromise;
                if (decision.decision === "approve") {
                  if (toolName === "ExitPlanMode" && typeof toolInput.plan === "string" && recordClaudePlanUpdate(streamState, toolInput.plan)) {
                    queue.push({ type: "plan.updated", state: { mode: "awaitingApproval", planText: toolInput.plan, approved: false } });
                  }
                  return { behavior: "allow" as const, updatedInput: toolInput, toolUseID: options.toolUseID };
                }
                return {
                  behavior: "deny" as const,
                  message: decision.reason ?? "Tool use denied.",
                  toolUseID: options.toolUseID,
                };
              } finally {
                this.#pendingApprovals.delete(ref);
                publisher.publishSnapshot();
              }
            },
            includePartialMessages: true,
            includeHookEvents: true,
            permissionMode: "default",
            persistSession: config.continuable === true,
            ...(config.continuable === true && this.#runtimeSessionRef
              ? { resume: this.#runtimeSessionRef }
              : {}),
          }, runtimeHome),
        });
        for await (const message of stream) {
          signal.throwIfAborted();
          const mapped = mapClaudeControlStreamMessage(message, streamState);
          for (const event of mapped.events) queue.push(event);
          if (mapped.sessionRef) {
            this.#runtimeSessionRef = mapped.sessionRef;
            queue.push({ type: "provider.metadata", provider: { nativeSessionId: mapped.sessionRef } });
          }
          if (mapped.terminal) {
            queue.push({ type: "turn.completed", usage: mapped.usage });
          }
          publisher.publishPolled();
          if (mapped.terminal) break;
        }
        publisher.publishPolled();
        if (config.continuable === true) {
          queue.push({ type: "continuation.updated", available: Boolean(this.#runtimeSessionRef) });
        }
        runtimeHomeLease.markRetainedHomeStable();
      } catch (error) {
        runtimeHomeLease.disposeCreatedRetainedHome();
        throw error;
      } finally {
        runtimeHomeLease.releaseAttempt(runtimeHome);
      }
    })();
    producer.then(() => queue.end(), (error) => queue.fail(error));
    try {
      yield* queue;
    } finally {
      publisher.stopPolling();
      signal.removeEventListener("abort", abort);
      abortController.abort();
      await producer.catch(() => undefined);
    }
  }

  submitToolDecision(decision: AiToolDecision): Promise<void> {
    if (!this.#decisions.submit(decision)) {
      return Promise.reject(new Error(`Tool is not waiting for a decision: ${decision.toolCallId}`));
    }
    return Promise.resolve();
  }

  dispose(): void {
    this.#runtimeHomeLease?.dispose();
    this.#runtimeHomeLease = null;
  }
}

export type PendingToolApproval = {
  id: string;
  turnId: TurnId;
  name: string;
  input: AiToolCall["input"];
  wait: NonNullable<AiToolCall["wait"]>;
  createdAt: string;
  updatedAt: string;
};

function pendingToolApproval(input: {
  toolUseId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  turnId: TurnId;
  waitReason: string | null;
}): PendingToolApproval {
  const now = new Date().toISOString();
  return {
    id: input.toolUseId,
    turnId: input.turnId,
    name: input.toolName,
    input: summarizeToolInputForUi(input.toolName, input.toolInput),
    wait: { reason: input.waitReason, since: now },
    createdAt: now,
    updatedAt: now,
  };
}

function toolApprovalWaitReason(
  toolName: string,
  options: { title?: string; decisionReason?: string }
): string | null {
  const reason = typeof options.decisionReason === "string" && options.decisionReason.trim()
    ? options.decisionReason.trim()
    : typeof options.title === "string" && options.title.trim()
      ? options.title.trim()
      : null;
  return reason ?? `Approve ${toolName}`;
}

export function overlayPendingToolApprovals(
  projection: TranscriptProjection,
  pendingApprovals: readonly PendingToolApproval[],
  fallbackTurnId: TurnId
): TranscriptProjection {
  if (pendingApprovals.length === 0) return projection;

  const pendingById = new Map(pendingApprovals.map((approval) => [approval.id, approval]));
  const toolCalls = projection.toolCalls.map((tool) => {
    const pending = pendingById.get(tool.id);
    if (!pending) return tool;
    pendingById.delete(tool.id);
    return {
      ...tool,
      name: tool.name || pending.name,
      input: tool.input ?? pending.input,
      status: "waiting" as const,
      wait: pending.wait,
      result: null,
      completedAt: null,
      updatedAt: pending.updatedAt,
    };
  });

  let nextSequence = Math.max(
    0,
    ...projection.transcript.map((entry) => entry.sequenceId ?? 0),
    ...toolCalls.map((tool) => tool.sequenceId ?? 0)
  );
  for (const pending of pendingById.values()) {
    nextSequence += 1;
    toolCalls.push(materializePendingToolApproval(
      pending.turnId ? pending : { ...pending, turnId: fallbackTurnId },
      nextSequence as AiToolCall["sequenceId"]
    ));
  }

  return {
    ...projection,
    toolCalls,
    digest: `pending:${projection.digest}:${pendingApprovals.map((approval) => approval.id).join(",")}`,
  };
}

function materializePendingToolApproval(
  pending: PendingToolApproval,
  sequenceId: AiToolCall["sequenceId"]
): AiToolCall {
  return {
    id: pending.id,
    sequenceId,
    turnId: pending.turnId,
    name: pending.name,
    input: pending.input,
    status: "waiting",
    wait: pending.wait,
    output: [],
    result: null,
    processId: null,
    progress: null,
    elapsedMs: null,
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
    completedAt: null,
  };
}

class CodexUiProvider implements AiProviderRunner {
  #liveSession: Awaited<ReturnType<typeof createCodexLiveSession>> | null = null;

  constructor(
    readonly resolvedProvider: ResolvedProvider,
    readonly resumeThreadId: string | null = null,
    readonly resumeTranscriptPath: string | null = null
  ) {}

  async *runTurn(input: AiRunTurnInput): AsyncIterable<AiRuntimeEvent> {
    const { config, prompt, signal } = input;
    if (config.continuable === true) {
      this.#liveSession ??= await createCodexLiveSession(
        this.resolvedProvider,
        { ...config, runtimeExecutionMode: "sdk" },
        "agent-framework-ai-codex-",
        true,
        this.resumeThreadId ?? undefined
      );
      yield {
        type: "provider.metadata",
        provider: {
          nativeSessionId: this.#liveSession.thread.id ?? null,
        },
      };
      yield* runCodexTranscriptTurn({
        liveSession: this.#liveSession,
        config,
        prompt: buildCodexTurnInput(config, prompt),
        signal,
        resumeTranscriptPath: this.resumeTranscriptPath,
      });
      yield { type: "continuation.updated", available: Boolean(this.#liveSession.thread.id) };
      return;
    }

    const liveSession = await createCodexLiveSession(
      this.resolvedProvider,
      { ...config, runtimeExecutionMode: "sdk" },
      "agent-framework-ai-codex-",
      true
    );
    try {
      yield {
        type: "provider.metadata",
        provider: {
          nativeSessionId: liveSession.thread.id ?? null,
        },
      };
      yield* runCodexTranscriptTurn({
        liveSession,
        config,
        prompt: buildCodexTurnInput(config, prompt),
        signal,
        resumeTranscriptPath: null,
      });
    } finally {
      liveSession.dispose();
    }
  }

  dispose(): void {
    this.#liveSession?.dispose();
    this.#liveSession = null;
  }
}

type CodexTranscriptThread = {
  id?: string | null;
  run?: (input: string, options?: Record<string, unknown>) => Promise<{ usage?: Parameters<typeof normalizeCodexAiUsage>[0] }>;
  runStreamed?: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }>;
};

type CodexTranscriptLiveSession = {
  runtimeHome: { root: string | null };
  thread: CodexTranscriptThread;
};

export async function* runCodexTranscriptTurn(input: {
  liveSession: CodexTranscriptLiveSession;
  config: AiSessionConfig;
  prompt: string;
  signal: AbortSignal;
  resumeTranscriptPath: string | null;
}): AsyncIterable<AiRuntimeEvent> {
  const queue = new RuntimeEventQueue();
  const publisher = createTimelineSnapshotPublisher({
    adapterName: "codex",
    workingDir: input.config.workingDir,
    queue,
    nativeSessionId: () => input.liveSession.thread.id ?? null,
    resolveTranscriptPath: () => resolveCodexTranscriptBinding({
      runtimeHomeRoot: input.liveSession.runtimeHome.root,
      threadId: input.liveSession.thread.id ?? null,
      workingDir: input.config.workingDir,
      resumeTranscriptPath: input.resumeTranscriptPath,
    }),
    signal: input.signal,
  });

  const producer = (async () => {
    publisher.publishPolled();
    publisher.startPolling();
    for await (const event of runCodexMetadataTurn(input.liveSession.thread, input.prompt, input.signal)) {
      queue.push(event);
      publisher.publishPolled();
    }
    publisher.publishPolled();
  })();
  producer.then(() => queue.end(), (error) => queue.fail(error));

  try {
    yield* queue;
  } finally {
    publisher.stopPolling();
    await producer.catch(() => undefined);
  }
}

async function* runCodexMetadataTurn(
  thread: CodexTranscriptThread,
  prompt: string,
  signal: AbortSignal
): AsyncIterable<AiRuntimeEvent> {
  if (!thread.runStreamed) {
    if (!thread.run) throw new Error("Codex SDK thread does not support running turns.");
    const result = await thread.run(prompt, { signal });
    yield { type: "turn.completed", usage: normalizeCodexAiUsage(result.usage, optionalNumber) };
    return;
  }
  const streamed = await thread.runStreamed(prompt, { signal });
  for await (const event of streamed.events) {
    signal.throwIfAborted();
    if (!event || typeof event !== "object") continue;
    const raw = event as Record<string, unknown>;
    if (raw.type === "turn.completed") {
      yield { type: "turn.completed", usage: normalizeCodexAiUsage(raw.usage as Parameters<typeof normalizeCodexAiUsage>[0], optionalNumber) };
    } else if (raw.type === "turn.failed") {
      yield { type: "error", error: raw.error ?? "Runtime turn failed" };
    } else if (raw.type === "error") {
      yield { type: "error", error: typeof raw.message === "string" ? raw.message : "Runtime stream error" };
    }
  }
}

class RuntimeEventQueue implements AsyncIterable<AiRuntimeEvent> {
  readonly #events: AiRuntimeEvent[] = [];
  readonly #waiters: Array<(value: IteratorResult<AiRuntimeEvent>) => void> = [];
  #done = false;
  #error: unknown = null;

  push(event: AiRuntimeEvent): void {
    if (this.#done) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.#events.push(event);
  }

  end(): void {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    this.#error = error;
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AiRuntimeEvent> {
    while (true) {
      if (this.#events.length > 0) {
        yield this.#events.shift()!;
        continue;
      }
      if (this.#done) {
        if (this.#error) throw this.#error;
        return;
      }
      const next = await new Promise<IteratorResult<AiRuntimeEvent>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) {
        if (this.#error) throw this.#error;
        return;
      }
      yield next.value;
    }
  }
}
