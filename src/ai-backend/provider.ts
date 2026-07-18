import { parseTierName } from "../types.js";
import { resolveProvider, type ResolvedProvider } from "../utils/provider-config.js";
import {
  buildClaudeQueryOptions,
  createClaudeRuntimeHomeLease,
  sanitizeClaudeEnv,
  type ClaudeRuntimeHomeLease,
} from "../providers/claude-agent-runtime.js";
import {
  createCodexLiveSession,
  normalizeCodexAiUsage,
} from "../providers/codex-agent-runtime.js";
import { PROVIDERS, PROVIDER_TYPES, providerKey } from "../providers/registry.js";
import { selectSdkRuntime } from "../providers/index.js";
import { optionalNumber } from "../utils/output.js";
import { toJsonValue as jsonValue } from "../scenario/protocol/common.js";
import type { ScenarioCommandPayload } from "../scenario/protocol/commands.js";
import type { ToolDecision } from "../scenario/protocol/commands.js";
import type { ProviderResumeTarget } from "../scenario/protocol/gateway.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import type {
  ProviderMetadataState,
  ProviderSessionConfig,
} from "../providers/provider-contract.js";
import { createDefaultProviderMetadata } from "./provider-metadata.js";
import {
  ProviderSettlementTimeoutError,
  waitForProviderSettlement,
} from "./provider-settlement.js";
import {
  claudePlanUpdateForTool,
  createClaudeControlStreamState,
  mapClaudeControlStreamMessage,
  mapClaudeStructuredEvents,
  toolApprovalWaitReason,
} from "../../adapters/claude/provider-events.js";
import { mapCodexProviderEvent } from "../../adapters/codex/provider-events.js";

export { buildClaudeQueryOptions } from "../providers/claude-agent-runtime.js";
export type { ProviderResumeTarget } from "../scenario/protocol/gateway.js";

export type ProviderRunTurnInput = {
  config: ProviderSessionConfig;
  prompt: string;
  turnId: string;
  signal: AbortSignal;
};

export interface ProviderRunner {
  readonly resolvedProvider: ResolvedProvider;
  runTurn(input: ProviderRunTurnInput): AsyncIterable<ScenarioCommandPayload>;
  dispose?(): Promise<void> | void;
}

export type ProviderToolAuthorization = (input: {
  toolCallId: string;
  turnId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<{ decision: ToolDecision; reason: string | null }>;

export class ResumeProviderMismatchError extends Error {
  constructor(targetRuntime: ProviderResumeTarget["sdkRuntime"], configuredRuntime: ReturnType<typeof selectSdkRuntime>) {
    super(`Resume target SDK runtime ${targetRuntime} is incompatible with configured SDK runtime ${configuredRuntime}.`);
    this.name = "ResumeProviderMismatchError";
  }
}

export function createProviderRunner(config: ProviderSessionConfig): ProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  return createResolvedProviderRunner(resolvedProvider);
}

export function createResolvedProviderRunner(
  resolvedProvider: ResolvedProvider,
  authorizeTool?: ProviderToolAuthorization,
): ProviderRunner {
  return providerRunnerFactory(selectSdkRuntime(resolvedProvider)).create(resolvedProvider, authorizeTool);
}

export function createResumeProviderRunner(
  config: ProviderSessionConfig,
  target: ProviderResumeTarget,
  authorizeTool?: ProviderToolAuthorization,
): ProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  return createResolvedResumeProviderRunner(resolvedProvider, target, authorizeTool);
}

export function createResolvedResumeProviderRunner(
  resolvedProvider: ResolvedProvider,
  target: ProviderResumeTarget,
  authorizeTool?: ProviderToolAuthorization,
): ProviderRunner {
  const configuredRuntime = selectSdkRuntime(resolvedProvider);
  if (configuredRuntime !== target.sdkRuntime) {
    throw new ResumeProviderMismatchError(target.sdkRuntime, configuredRuntime);
  }
  return providerRunnerFactory(configuredRuntime).resume(resolvedProvider, target, authorizeTool);
}

export function resolveSessionProvider(config: ProviderSessionConfig): ResolvedProvider {
  const tier = parseTierName(config.model ?? undefined);
  return resolveProvider(tier, "sdk");
}

export function buildCodexTurnInput(config: ProviderSessionConfig, prompt: string): string {
  if (!config.systemPrompt) return prompt;
  return `System instructions:\n${config.systemPrompt}\n\nUser request:\n${prompt}`;
}

type ProviderRunnerFactory = {
  create(resolvedProvider: ResolvedProvider, authorizeTool?: ProviderToolAuthorization): ProviderRunner;
  resume(resolvedProvider: ResolvedProvider, target: ProviderResumeTarget, authorizeTool?: ProviderToolAuthorization): ProviderRunner;
};

const PROVIDER_RUNNER_FACTORIES: Record<ReturnType<typeof selectSdkRuntime>, ProviderRunnerFactory> = {
  claude: {
    create: (resolvedProvider, authorizeTool) => new ClaudeProviderRunner(resolvedProvider, null, authorizeTool),
    resume: (resolvedProvider, target, authorizeTool) =>
      new ClaudeProviderRunner(
        resolvedProvider,
        target.nativeSessionId,
        authorizeTool,
      ),
  },
  codex: {
    create: (resolvedProvider) => new CodexProviderRunner(resolvedProvider),
    resume: (resolvedProvider, target) =>
      new CodexProviderRunner(
        resolvedProvider,
        target.nativeSessionId,
      ),
  },
};

function providerRunnerFactory(runtime: ReturnType<typeof selectSdkRuntime>): ProviderRunnerFactory {
  return PROVIDER_RUNNER_FACTORIES[runtime];
}

export function providerMetadataForResolvedProvider(resolvedProvider: ResolvedProvider): ProviderMetadataState {
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

class ClaudeProviderRunner implements ProviderRunner {
  #runtimeSessionRef: string | null = null;
  #runtimeHomeLease: ClaudeRuntimeHomeLease | null = null;

  constructor(
    readonly resolvedProvider: ResolvedProvider,
    runtimeSessionRef: string | null = null,
    private readonly authorizeTool?: ProviderToolAuthorization,
  ) {
    this.#runtimeSessionRef = runtimeSessionRef;
  }

  async *runTurn(input: ProviderRunTurnInput): AsyncIterable<ScenarioCommandPayload> {
    const { config, prompt, signal } = input;
    signal.throwIfAborted();
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    signal.addEventListener("abort", abort, { once: true });
    const queue = new ProviderCommandQueue();
    const env = sanitizeClaudeEnv(
      process.env,
      this.resolvedProvider.type === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
    );
    const streamState = createClaudeControlStreamState(this.#runtimeSessionRef);
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
      try {
        const stream = query({
          prompt,
          options: buildClaudeQueryOptions(config, this.resolvedProvider, abortController, env, {
            canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; title?: string; decisionReason?: string }) => {
              const ref = options.toolUseID;
              const planUpdate = claudePlanUpdateForTool(streamState, toolName, toolInput);
              if (planUpdate) queue.push(planUpdate);
              const decision = this.authorizeTool
                ? await this.authorizeTool({
                    toolCallId: ref,
                    turnId: input.turnId,
                    toolName,
                    toolInput,
                    signal: options.signal,
                  })
                : { decision: "deny" as const, reason: "Canonical tool authorization is unavailable." };
              if (decision.decision === "approve") {
                queue.push({ type: "toolExecutionStarted", toolCallId: ref });
                return { behavior: "allow" as const, updatedInput: toolInput, toolUseID: options.toolUseID };
              }
              return {
                behavior: "deny" as const,
                message: decision.reason ?? toolApprovalWaitReason(toolName, options),
                toolUseID: options.toolUseID,
              };
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
          for (const event of mapClaudeStructuredEvents(message, input.turnId)) queue.push(event);
          if (mapped.sessionRef) {
            this.#runtimeSessionRef = mapped.sessionRef;
            queue.push({ type: "providerStateObserved", data: { nativeSessionId: mapped.sessionRef } });
          }
          if (mapped.terminal && mapped.usage) {
            queue.push({ type: "providerStateObserved", data: { usage: mapped.usage } });
          }
          if (mapped.terminal) break;
        }
        if (config.continuable === true) {
          queue.push({
            type: "continuationStateChanged",
            data: { available: Boolean(this.#runtimeSessionRef) },
          });
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
      signal.removeEventListener("abort", abort);
      abortController.abort();
      const settlement = await waitForProviderSettlement(producer);
      if (settlement.status === "timedOut") {
        throw new ProviderSettlementTimeoutError("Claude provider producer did not settle after abort");
      }
    }
  }

  dispose(): void {
    this.#runtimeHomeLease?.dispose();
    this.#runtimeHomeLease = null;
  }
}

class CodexProviderRunner implements ProviderRunner {
  #liveSession: Awaited<ReturnType<typeof createCodexLiveSession>> | null = null;

  constructor(
    readonly resolvedProvider: ResolvedProvider,
    readonly resumeThreadId: string | null = null
  ) {}

  async *runTurn(input: ProviderRunTurnInput): AsyncIterable<ScenarioCommandPayload> {
    const continuable = input.config.continuable === true;
    if (continuable) {
      this.#liveSession ??= await createCodexLiveSession(
        this.resolvedProvider,
        { ...input.config, runtimeExecutionMode: "sdk" },
        "agent-framework-ai-codex-",
        true,
        this.resumeThreadId ?? undefined
      );
      yield* this.runSessionTurn(this.#liveSession, input);
      yield {
        type: "continuationStateChanged",
        data: { available: Boolean(this.#liveSession.thread.id) },
      };
      return;
    }

    const liveSession = await createCodexLiveSession(
      this.resolvedProvider,
      { ...input.config, runtimeExecutionMode: "sdk" },
      "agent-framework-ai-codex-",
      false
    );
    try {
      yield* this.runSessionTurn(liveSession, input);
    } finally {
      liveSession.dispose();
    }
  }

  private async *runSessionTurn(
    liveSession: CodexTranscriptLiveSession,
    input: ProviderRunTurnInput,
  ): AsyncIterable<ScenarioCommandPayload> {
    yield {
      type: "providerStateObserved",
      data: {
        nativeSessionId: liveSession.thread.id ?? null,
      },
    };
    yield* runCodexTranscriptTurn({
      liveSession,
      prompt: buildCodexTurnInput(input.config, input.prompt),
      turnId: input.turnId,
      signal: input.signal,
    });
  }

  dispose(): void {
    this.#liveSession?.dispose();
    this.#liveSession = null;
  }
}

type CodexTranscriptThread = {
  id?: string | null;
  run?: (input: string, options?: Record<string, unknown>) => Promise<{
    finalResponse?: string;
    usage?: Parameters<typeof normalizeCodexAiUsage>[0];
  }>;
  runStreamed?: (input: string, options?: Record<string, unknown>) => Promise<{ events: AsyncIterable<unknown> }>;
};

type CodexTranscriptLiveSession = {
  thread: CodexTranscriptThread;
};

export async function* runCodexTranscriptTurn(input: {
  liveSession: CodexTranscriptLiveSession;
  prompt: string;
  turnId: string;
  signal: AbortSignal;
}): AsyncIterable<ScenarioCommandPayload> {
  yield* runCodexMetadataTurn(input.liveSession.thread, input.prompt, input.turnId, input.signal);
}

async function* runCodexMetadataTurn(
  thread: CodexTranscriptThread,
  prompt: string,
  turnId: string,
  signal: AbortSignal,
): AsyncIterable<ScenarioCommandPayload> {
  if (!thread.runStreamed) {
    if (!thread.run) throw new Error("Codex SDK thread does not support running turns.");
    const result = await thread.run(prompt, { signal });
    if (result.finalResponse) {
      yield {
        type: "assistantMessageCompleted",
        messageId: `assistant:${turnId}`,
        turnId,
        content: result.finalResponse,
        contentDigest: digestScenarioValue(result.finalResponse),
      };
    }
    yield {
      type: "providerStateObserved",
      data: { usage: jsonValue(normalizeCodexAiUsage(result.usage, optionalNumber)) },
    };
    return;
  }
  const streamed = await thread.runStreamed(prompt, { signal });
  for await (const event of streamed.events) {
    signal.throwIfAborted();
    for (const mapped of mapCodexProviderEvent(event, turnId)) yield mapped;
  }
}

class ProviderCommandQueue implements AsyncIterable<ScenarioCommandPayload> {
  readonly #events: ScenarioCommandPayload[] = [];
  readonly #waiters: Array<(value: IteratorResult<ScenarioCommandPayload>) => void> = [];
  #done = false;
  #failure: { error: unknown } | null = null;

  push(event: ScenarioCommandPayload): void {
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
    this.#failure = { error };
    this.end();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ScenarioCommandPayload> {
    while (true) {
      if (this.#events.length > 0) {
        yield this.#events.shift()!;
        continue;
      }
      if (this.#done) {
        if (this.#failure !== null) throw this.#failure.error;
        return;
      }
      const next = await new Promise<IteratorResult<ScenarioCommandPayload>>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next.done) {
        if (this.#failure !== null) throw this.#failure.error;
        return;
      }
      yield next.value;
    }
  }
}
