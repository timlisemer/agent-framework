import { parseTierName } from "../types.js";
import { resolveProvider, type ResolvedProvider } from "../utils/provider-config.js";
import { summarizeToolInputForUi } from "../utils/tool-input-summary.js";
import {
  buildClaudeQueryOptions,
  createClaudeUiStreamState,
  mapClaudeUiStreamMessage,
  recordClaudePlanUpdate,
  sanitizeClaudeEnv,
} from "../providers/claude-agent-runtime.js";
import {
  createCodexLiveSession,
  createCodexUiStreamState,
  mapCodexUiStreamEvent,
  normalizeCodexAiUsage,
  withCodexThread,
} from "../providers/codex-agent-runtime.js";
import { PROVIDER_TYPES } from "../providers/registry.js";
import { selectSdkRuntime } from "../providers/index.js";
import { optionalNumber } from "../utils/output.js";
import type { AiSessionConfig, AiToolDecision } from "../ai-protocol/index.js";
import type { AiRuntimeEvent, AiRunTurnInput } from "./runtime-events.js";
import { DecisionBroker } from "./decision-broker.js";

export { buildClaudeQueryOptions } from "../providers/claude-agent-runtime.js";

export interface AiProviderRunner {
  readonly resolvedProvider: ResolvedProvider;
  runTurn(input: AiRunTurnInput): AsyncIterable<AiRuntimeEvent>;
  submitToolDecision?(decision: AiToolDecision): Promise<void>;
  dispose?(): Promise<void> | void;
}

export function createProviderRunner(config: AiSessionConfig): AiProviderRunner {
  const resolvedProvider = resolveSessionProvider(config);
  return createResolvedProviderRunner(resolvedProvider);
}

export function createResolvedProviderRunner(resolvedProvider: ResolvedProvider): AiProviderRunner {
  return selectSdkRuntime(resolvedProvider) === "claude"
    ? new ClaudeUiProvider(resolvedProvider)
    : new CodexUiProvider(resolvedProvider);
}

export function resolveSessionProvider(config: AiSessionConfig): ResolvedProvider {
  const tier = parseTierName(config.model ?? undefined);
  return resolveProvider(tier, "sdk");
}

export function buildCodexTurnInput(config: AiSessionConfig, prompt: string): string {
  if (!config.systemPrompt) return prompt;
  return `System instructions:\n${config.systemPrompt}\n\nUser request:\n${prompt}`;
}

class ClaudeUiProvider implements AiProviderRunner {
  #runtimeSessionRef: string | null = null;
  readonly #decisions = new DecisionBroker();

  constructor(readonly resolvedProvider: ResolvedProvider) {}

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
    const streamState = createClaudeUiStreamState(this.#runtimeSessionRef);
    const producer = (async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const stream = query({
        prompt,
        options: buildClaudeQueryOptions(config, this.resolvedProvider, abortController, env, {
          canUseTool: async (toolName: string, toolInput: Record<string, unknown>, options: { signal: AbortSignal; toolUseID: string; title?: string; decisionReason?: string }) => {
            const ref = options.toolUseID;
            streamState.seenTools.add(options.toolUseID);
            queue.push({ type: "tool.created", ref, name: toolName, input: summarizeToolInputForUi(toolName, toolInput) });
            queue.push({ type: "tool.updated", ref, status: "waiting", waitReason: options.title ?? options.decisionReason ?? null });
            const decision = await this.#decisions.waitForDecision(ref, options.signal);
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
          },
          includePartialMessages: true,
          includeHookEvents: true,
          permissionMode: "default",
          persistSession: config.continuable === true,
          ...(config.continuable === true && this.#runtimeSessionRef
            ? { resume: this.#runtimeSessionRef }
            : {}),
        }),
      });
      for await (const message of stream) {
        signal.throwIfAborted();
        const mapped = mapClaudeUiStreamMessage(message, streamState);
        for (const event of mapped.events) queue.push(event);
        if (mapped.sessionRef) this.#runtimeSessionRef = mapped.sessionRef;
        if (mapped.terminal) break;
      }
      if (config.continuable === true) {
        queue.push({ type: "continuation.updated", available: Boolean(this.#runtimeSessionRef) });
      }
    })();
    producer.then(() => queue.end(), (error) => queue.fail(error));
    try {
      yield* queue;
    } finally {
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
}

class CodexUiProvider implements AiProviderRunner {
  #liveSession: Awaited<ReturnType<typeof createCodexLiveSession>> | null = null;

  constructor(readonly resolvedProvider: ResolvedProvider) {}

  async *runTurn(input: AiRunTurnInput): AsyncIterable<AiRuntimeEvent> {
    const { config, prompt, signal } = input;
    if (config.continuable === true) {
      this.#liveSession ??= await createCodexLiveSession(
        this.resolvedProvider,
        config,
        "agent-framework-ai-codex-"
      );
      yield* runCodexUiTurn(this.#liveSession.thread, buildCodexTurnInput(config, prompt), signal);
      yield { type: "continuation.updated", available: Boolean(this.#liveSession.thread.id) };
      return;
    }

    const events = await withCodexThread(
      this.resolvedProvider,
      config,
      "agent-framework-ai-codex-",
      async (thread) => collectCodexUiTurn(thread, buildCodexTurnInput(config, prompt), signal)
    );
    yield* events;
  }

  dispose(): void {
    this.#liveSession?.dispose();
    this.#liveSession = null;
  }
}

async function* runCodexUiTurn(
  thread: Awaited<ReturnType<typeof createCodexLiveSession>>["thread"],
  prompt: string,
  signal: AbortSignal
): AsyncIterable<AiRuntimeEvent> {
  if (!thread.runStreamed) {
    const result = await thread.run(prompt, { signal });
    yield { type: "message.created", ref: "assistant", content: "" };
    yield {
      type: "message.completed",
      ref: "assistant",
      content: result.finalResponse ?? "",
      usage: normalizeCodexAiUsage(result.usage, optionalNumber),
    };
    return;
  }
  const state = createCodexUiStreamState();
  const streamed = await thread.runStreamed(prompt, { signal });
  for await (const event of streamed.events) {
    signal.throwIfAborted();
    for (const mapped of mapCodexUiStreamEvent(event, state)) yield mapped;
  }
}

async function collectCodexUiTurn(
  thread: Awaited<ReturnType<typeof createCodexLiveSession>>["thread"],
  prompt: string,
  signal: AbortSignal
): Promise<AiRuntimeEvent[]> {
  const events: AiRuntimeEvent[] = [];
  for await (const event of runCodexUiTurn(thread, prompt, signal)) events.push(event);
  return events;
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
