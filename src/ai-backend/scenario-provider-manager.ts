import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { adapterSpecByName } from "../adapter/spec.js";
import { assertManagedRuntimeHomeConfig } from "../providers/managed-runtime-home.js";
import { selectSdkRuntime } from "../providers/index.js";
import { FULL_RUN_CAPABILITIES } from "../scenario/protocol/capabilities.js";
import { idSchema, toJsonObject, toJsonValue } from "../scenario/protocol/common.js";
import type { ScenarioCommandPayload } from "../scenario/protocol/commands.js";
import type { ToolDecision } from "../scenario/protocol/commands.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import { scenarioProtocolSchemaDigest } from "../scenario/protocol/schema.js";
import {
  isTerminalRunStatus,
  isTerminalToolStatus,
  type ScenarioSnapshot,
} from "../scenario/protocol/snapshot.js";
import { RuntimeAuthorizationWaiter } from "../scenario/runtime/authorization-waiter.js";
import { ScenarioRuntime } from "../scenario/runtime/runtime.js";
import { createAgentFrameworkScenarioRuntime } from "../effects/scenario-runtime-factory.js";
import type { ResolvedProvider } from "../utils/provider-config.js";
import {
  parseProviderGatewayPolicy,
  type ProviderMetadataState,
  type ProviderGatewayPolicy,
  type ProviderSessionConfig,
} from "../providers/provider-contract.js";
import type { SdkRuntime } from "../providers/types.js";
import { VERSION } from "../version.js";
import { errorMessage } from "../utils/output.js";
import type { ScenarioProviderHost } from "./gateway.js";
import {
  createResolvedProviderRunner,
  createResolvedResumeProviderRunner,
  providerMetadataForResolvedProvider,
  resolveSessionProvider,
  type ProviderResumeTarget,
  type ProviderRunner,
  type ProviderToolAuthorization,
} from "./provider.js";
import { toPublicError } from "./public-errors.js";
import { isMissingFileError } from "../utils/filesystem-errors.js";
import { createScenarioCommandEnvelope } from "../scenario/protocol/command-envelope.js";
import {
  PROVIDER_SETTLEMENT_TIMEOUT_MS,
  ProviderSettlementTimeoutError,
  providerSettlementTimeout,
  waitForProviderSettlement,
  type ProviderSettlement,
} from "./provider-settlement.js";
import { OperationCancelledError } from "../utils/cancellation.js";
import { reportBackgroundError } from "../utils/background-errors.js";
import { mergeProviderMetadata } from "./provider-metadata.js";

type GatewayRunConfig = Parameters<ScenarioProviderHost["start"]>[0];
type ProviderGatewayRunConfig = GatewayRunConfig & ProviderGatewayPolicy;
type GatewayResumeTarget = Parameters<ScenarioProviderHost["resume"]>[2];
type RegisteredProvider = {
  entry: ProviderRun;
  resolved: ResolvedProvider;
};

export type ScenarioProviderManagerOptions = {
  runtime?: ScenarioRuntime;
  resolveProvider?: (config: ProviderSessionConfig) => ResolvedProvider;
  createRunner?: (
    provider: ResolvedProvider,
    authorizeTool: ProviderToolAuthorization,
  ) => ProviderRunner;
  createResumeRunner?: (
    provider: ResolvedProvider,
    target: ProviderResumeTarget,
    authorizeTool: ProviderToolAuthorization,
  ) => ProviderRunner;
  onBackgroundError?: (
    error: unknown,
    context: { runId: string; turnId: string },
  ) => void;
  providerSettlementTimeoutMs?: number;
};

type ActiveTurn = {
  turnId: string;
  controller: AbortController;
  promise: Promise<void>;
};

type ProviderBackgroundTask = {
  kind: "turn" | "authorizationTerminalization";
  runId: string;
  turnId: string;
  promise: Promise<unknown>;
  fence?: { fenced: boolean };
};

type ProviderRun = {
  runId: string;
  nativeSessionId: string;
  adapter: SdkRuntime;
  provider: string;
  config: ProviderSessionConfig;
  runner: ProviderRunner;
  activeTurn: ActiveTurn | null;
  tearingDown: boolean;
  teardownPromise: Promise<unknown[]> | null;
};

type ProviderRunTeardownOptions = {
  lifecycleCommand: ScenarioCommandPayload | null;
  skipLifecycleWhenTerminal: boolean;
  fallbackCancellationReason: string;
  pendingToolReason: string | null;
  initialFailures?: readonly unknown[];
};

function providerConfigurationState(
  config: ProviderGatewayRunConfig,
  resolved: ResolvedProvider,
) {
  return {
    model: resolved.modelId,
    systemPromptDigest: digestScenarioValue(config.systemPrompt),
    sdkRuntimeEnvironment: config.sdkRuntimeEnvironment,
  };
}

/** Canonical Scenario provider lifecycle; it owns no UI/session projection. */
export class ScenarioProviderManager {
  public readonly runtime: ScenarioRuntime;
  readonly #runs = new Map<string, ProviderRun>();
  readonly #backgroundTasks = new Set<ProviderBackgroundTask>();
  readonly #authorizationWaiter = new RuntimeAuthorizationWaiter();
  readonly #providerSettlementTimeoutMs: number;

  public constructor(private readonly options: ScenarioProviderManagerOptions = {}) {
    this.runtime = options.runtime ?? createAgentFrameworkScenarioRuntime();
    this.#providerSettlementTimeoutMs = providerSettlementTimeout(
      options.providerSettlementTimeoutMs ?? PROVIDER_SETTLEMENT_TIMEOUT_MS,
    );
  }

  public readonly host: ScenarioProviderHost = {
    start: (config) => this.start(config),
    resume: (runId, config, target) => this.resume(runId, config, target),
    send: (runId, turnId, input) => this.send(runId, turnId, input),
    cancel: (runId, turnId) => this.cancel(runId, turnId),
    close: (runId) => this.close(runId),
    settleToolDecision: (runId, toolCallId, decision, reason) =>
      this.settleToolDecision(runId, toolCallId, decision, reason),
  };

  private async start(input: GatewayRunConfig): Promise<{ runId: string }> {
    const config = this.providerGatewayRunConfig(input);
    const runId = `provider-${randomUUID()}`;
    const nativeSessionId = `provider-host-${randomUUID()}`;
    const { entry, resolved } = this.registerProvider({
      runId,
      nativeSessionId,
      gatewayConfig: config,
    });
    const { adapter, config: providerConfig } = entry;
    try {
      await this.runtime.ensureRunStarted(createScenarioCommandEnvelope({
        runId,
        source: { kind: "providerSdk", adapter, provider: resolved.type, nativeSessionId },
        payload: {
          type: "startRun",
          workingDir: providerConfig.workingDir,
          projectDir: providerConfig.workingDir,
          capabilities: providerCapabilities(adapter),
          storagePolicy: "durable",
          runtimeHome: config.runtimeHome,
          engineVersion: VERSION,
          schemaDigest: scenarioProtocolSchemaDigest(),
          configuration: {
            provider: resolved.type,
            ...providerConfigurationState(config, resolved),
            continuable: config.continuable,
            toolAuthorization: adapter === "claude" ? "preExecution" : "observationOnly",
            ...(adapter === "claude" ? { nonInteractiveToolFallback: "deny" } : {}),
            rulePipeline: "shared",
          },
        },
      }));
      await this.dispatch(entry, {
        type: "providerStateObserved",
        data: {
          ...toJsonObject(providerMetadataForResolvedProvider(resolved)),
          configuration: providerConfigurationState(config, resolved),
        },
      });
      return { runId };
    } catch (error) {
      return this.failInitialization(entry, error, null);
    }
  }

  private async resume(
    runId: string,
    input: GatewayRunConfig,
    target: GatewayResumeTarget,
  ): Promise<{ runId: string }> {
    const config = this.providerGatewayRunConfig(input);
    if (this.#runs.has(runId)) throw new Error(`Provider run is already active: ${runId}`);
    const priorSnapshot = await this.runtime.snapshot(runId);
    const priorStatus = priorSnapshot.status;
    const resumeConfig = this.validateProviderResumeConfiguration(priorSnapshot, config);
    const nativeSessionId = target.nativeSessionId;
    const { entry, resolved } = this.registerProvider({
      runId,
      nativeSessionId,
      gatewayConfig: resumeConfig,
      resumeTarget: target,
      validate: ({ resolved, adapter }) => {
        this.validateProviderResumeIdentity(priorSnapshot, target, resolved, adapter);
      },
    });
    try {
      await this.dispatch(entry, {
        type: "resumeRun",
        data: {
          provider: resolved.type,
          nativeSessionId,
        },
      });
      await this.dispatch(entry, {
        type: "providerStateObserved",
        data: {
          ...toJsonObject(providerMetadataForResolvedProvider(resolved)),
          nativeSessionId,
          configuration: providerConfigurationState(resumeConfig, resolved),
          configurationTransition: {
            previous: priorSnapshot.providerState.configuration ?? null,
            current: providerConfigurationState(resumeConfig, resolved),
          },
        },
      });
      return { runId };
    } catch (error) {
      return this.failInitialization(entry, error, priorStatus);
    }
  }

  private async failInitialization(
    entry: ProviderRun,
    primaryError: unknown,
    priorStatus: string | null,
  ): Promise<never> {
    const failures: unknown[] = [primaryError];
    try {
      const snapshot = await this.runtime.snapshot(entry.runId);
      const lifecycleCommitted = priorStatus === null || snapshot.status !== priorStatus;
      if (lifecycleCommitted && !isTerminalRunStatus(snapshot.status)) {
        await this.dispatch(entry, {
          type: "runtimeErrorObserved",
          data: toJsonValue(toPublicError(primaryError, {
            publicMessage: "Provider initialization failed",
          })),
        });
      }
    } catch (error) {
      if (!isMissingFileError(error)) failures.push(error);
    }
    const teardownFailures = await this.teardownProviderRun(entry, {
      lifecycleCommand: null,
      skipLifecycleWhenTerminal: false,
      fallbackCancellationReason: "Provider initialization failed",
      pendingToolReason: null,
      initialFailures: failures,
    });
    if (teardownFailures.length === 1) throw primaryError;
    throw new AggregateError(teardownFailures, "Provider initialization and cleanup failed");
  }

  private providerGatewayRunConfig(config: GatewayRunConfig): ProviderGatewayRunConfig {
    return { ...config, ...parseProviderGatewayPolicy(config) };
  }

  private providerConfig(config: ProviderGatewayRunConfig): ProviderSessionConfig {
    const providerConfig: ProviderSessionConfig = {
      model: config.model,
      workingDir: path.resolve(config.workingDir ?? process.cwd()),
      systemPrompt: config.systemPrompt,
      continuable: config.continuable,
      sdkRuntimeEnvironment: config.sdkRuntimeEnvironment,
      sdkRuntimeHome: config.runtimeHome.kind === "managed" ? "managed" : "native",
    };
    assertManagedRuntimeHomeConfig(providerConfig);
    return providerConfig;
  }

  private registerProvider(input: {
    runId: string;
    nativeSessionId: string;
    gatewayConfig: ProviderGatewayRunConfig;
    resumeTarget?: GatewayResumeTarget;
    validate?: (input: { resolved: ResolvedProvider; adapter: SdkRuntime }) => void;
  }): RegisteredProvider {
    const providerConfig = this.providerConfig(input.gatewayConfig);
    const resolved = this.options.resolveProvider?.(providerConfig) ?? resolveSessionProvider(providerConfig);
    const adapter = selectSdkRuntime(resolved);
    input.validate?.({ resolved, adapter });
    const authorizeTool = this.providerAuthorization(input.runId, adapter);
    const runner = input.resumeTarget
      ? this.options.createResumeRunner?.(resolved, input.resumeTarget, authorizeTool) ??
        createResolvedResumeProviderRunner(resolved, input.resumeTarget, authorizeTool)
      : this.options.createRunner?.(resolved, authorizeTool) ??
        createResolvedProviderRunner(resolved, authorizeTool);
    const entry: ProviderRun = {
      runId: input.runId,
      nativeSessionId: input.nativeSessionId,
      adapter,
      provider: resolved.type,
      config: providerConfig,
      runner,
      activeTurn: null,
      tearingDown: false,
      teardownPromise: null,
    };
    this.#runs.set(input.runId, entry);
    return { entry, resolved };
  }

  private validateProviderResumeConfiguration(
    snapshot: ScenarioSnapshot,
    config: ProviderGatewayRunConfig,
  ): ProviderGatewayRunConfig {
    if (!isTerminalRunStatus(snapshot.status)) {
      throw new Error(`Provider run is not resumable while status is ${snapshot.status}`);
    }
    if (snapshot.manifest.source.kind !== "providerSdk") {
      throw new Error(`Cannot resume non-provider Scenario run: ${snapshot.runId}`);
    }
    if (!config.continuable) {
      throw new Error("Provider resume requires a continuable session configuration");
    }
    const persistedWorkingDir = snapshot.identity.workingDir;
    if (persistedWorkingDir === null) {
      throw new Error("Persisted provider working directory is unavailable");
    }
    const canonicalWorkingDir = path.resolve(persistedWorkingDir);
    const requestedWorkingDir = path.resolve(config.workingDir ?? persistedWorkingDir);
    if (requestedWorkingDir !== canonicalWorkingDir) {
      throw new Error("Provider resume working directory differs from the canonical run");
    }
    if (!isDeepStrictEqual(snapshot.manifest.runtimeHome, config.runtimeHome)) {
      throw new Error("Persisted provider runtime-home policy is incompatible with the resume request");
    }
    return { ...config, workingDir: canonicalWorkingDir };
  }

  private validateProviderResumeIdentity(
    snapshot: ScenarioSnapshot,
    target: GatewayResumeTarget,
    resolved: ResolvedProvider,
    adapter: SdkRuntime,
  ): void {
    if (target.sdkRuntime !== adapter) {
      throw new Error(`Resume target ${target.sdkRuntime} is incompatible with resolved adapter ${adapter}`);
    }
    const persistedAdapters = [snapshot.manifest.adapter, snapshot.manifest.source.adapter];
    if (persistedAdapters.some((persisted) => persisted !== adapter)) {
      throw new Error(`Persisted provider adapter is incompatible with resolved adapter ${adapter}`);
    }
    const persistedProviders = [snapshot.manifest.provider, snapshot.manifest.source.provider];
    if (persistedProviders.some((persisted) => persisted !== resolved.type)) {
      throw new Error(`Persisted provider identity is incompatible with resolved provider ${resolved.type}`);
    }
  }

  private async send(runId: string, turnId: string, input: string): Promise<void> {
    const entry = this.requiredRun(runId);
    if (entry.activeTurn) throw new Error(`Provider run already has an active turn: ${runId}`);
    const controller = new AbortController();
    const admission = this.dispatch(entry, {
      type: "userMessageSubmitted",
      messageId: `user:${turnId}`,
      turnId,
      content: input,
      contentDigest: digestScenarioValue(input),
    });
    let reservation!: ActiveTurn;
    let providerStarted = false;
    const settlement = admission.then(async () => {
      if (entry.activeTurn !== reservation) {
        throw new Error(`Provider turn reservation was lost: ${runId}`);
      }
      if (controller.signal.aborted) {
        entry.activeTurn = null;
        return;
      }
      providerStarted = true;
      await this.runTurn(entry, turnId, input, controller);
    }, (error: unknown) => {
      controller.abort();
      if (entry.activeTurn === reservation) entry.activeTurn = null;
      throw error;
    });
    reservation = { turnId, controller, promise: settlement };
    entry.activeTurn = reservation;
    this.trackBackgroundTask({ kind: "turn", runId, turnId, promise: settlement }, (error) => {
      if (providerStarted) {
        this.reportBackgroundError(error, { runId, turnId });
      }
    });
    await admission;
  }

  private async runTurn(
    entry: ProviderRun,
    turnId: string,
    input: string,
    controller: AbortController,
  ): Promise<void> {
    try {
      for await (const event of entry.runner.runTurn({
        config: entry.config,
        prompt: input,
        turnId,
        signal: controller.signal,
      })) {
        if (!this.isAttached(entry)) return;
        if (!(await this.applyProviderCommand(entry, event))) return;
      }
    } catch (error) {
      if (error instanceof ProviderSettlementTimeoutError) throw error;
      if (!this.isAttached(entry)) return;
      if (controller.signal.aborted) {
        const status = (await this.runtime.snapshot(entry.runId)).status;
        if (!isTerminalRunStatus(status)) {
          const content = "cancelled: Operation cancelled (recoverable)";
          await this.dispatch(entry, {
            type: "assistantMessageCompleted",
            messageId: `message-terminal-${turnId}-cancelled`,
            turnId,
            content,
            contentDigest: digestScenarioValue(content),
          });
        }
      } else {
        const failures: unknown[] = [];
        try {
          await this.dispatch(entry, {
            type: "runtimeErrorObserved",
            data: toJsonValue(toPublicError(error)),
          });
        } catch (dispatchError) {
          failures.push(dispatchError);
        }
        try {
          await this.detachFailedProviderRun(entry, turnId, "Provider turn failed");
        } catch (detachError) {
          failures.push(detachError);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, "Provider failure persistence and detachment failed");
        }
      }
    } finally {
      if (entry.activeTurn?.controller === controller) entry.activeTurn = null;
    }
  }

  private async applyProviderCommand(
    entry: ProviderRun,
    payload: ScenarioCommandPayload,
  ): Promise<boolean> {
    if (!this.isAttached(entry)) return false;
    if (
      payload.type === "toolExecutionStarted" ||
      payload.type === "toolCompleted" ||
      payload.type === "toolFailed"
    ) {
      const snapshot = await this.runtime.snapshot(entry.runId);
      if (!this.isAttached(entry)) return false;
      if (snapshot.toolCalls.find((tool) => tool.id === payload.toolCallId)?.status === "denied") return true;
      if (payload.type === "toolExecutionStarted") {
        await this.dispatch(entry, payload);
        return true;
      }
    }
    let canonicalPayload = payload;
    if (payload.type === "providerStateObserved") {
      const snapshot = await this.runtime.snapshot(entry.runId);
      if (!this.isAttached(entry)) return false;
      const incoming = toJsonObject(payload.data ?? {});
      canonicalPayload = {
        ...payload,
        data: toJsonValue(mergeProviderMetadata(
          snapshot.providerState as Partial<ProviderMetadataState>,
          incoming as Partial<ProviderMetadataState>,
        )),
      };
    }
    const observedNativeSessionId = providerObservedNativeSessionId(canonicalPayload);
    const result = await this.dispatch(entry, canonicalPayload, observedNativeSessionId ?? entry.nativeSessionId);
    if (observedNativeSessionId && this.isAttached(entry)) {
      entry.nativeSessionId = observedNativeSessionId;
    }
    if (canonicalPayload.type === "toolRequested" && (result.status === "denied" || result.status === "failed")) {
      entry.activeTurn?.controller.abort(result.reason);
    }
    if (isFatalProviderError(canonicalPayload)) {
      await this.detachFailedProviderRun(entry, entry.activeTurn?.turnId ?? "provider-turn", "Provider runtime failed");
      return false;
    }
    return true;
  }

  private async detachFailedProviderRun(
    entry: ProviderRun,
    turnId: string,
    reason: string,
  ): Promise<void> {
    if (!this.isAttached(entry)) return;
    entry.tearingDown = true;
    if (this.#runs.get(entry.runId) === entry) this.#runs.delete(entry.runId);
    entry.activeTurn?.controller.abort(reason);
    this.#authorizationWaiter.cancelRun(entry.runId, reason);

    const failures: unknown[] = [];
    const timedOut = await this.collectSettlementFailure(this.disposeRunner(entry), failures);
    if (timedOut) {
      await this.recordProviderCleanupTimeout(entry, "detaching a failed provider turn", failures);
    }
    for (const failure of failures) {
      this.reportBackgroundError(failure, { runId: entry.runId, turnId });
    }
  }

  private providerAuthorization(
    runId: string,
    adapter: SdkRuntime,
  ): ProviderToolAuthorization {
    return async (input) => {
      const entry = this.requiredRun(runId);
      const canonical = adapterSpecByName(adapter).canonicalizeToolCall(input.toolName, input.toolInput);
      const canonicalInput = toJsonValue(canonical.toolInput);
      let markDispatchSettled!: () => void;
      const dispatchSettled = new Promise<void>((resolve) => { markDispatchSettled = resolve; });
      const pendingDecision = this.#authorizationWaiter.wait(
        runId,
        input.turnId,
        input.toolCallId,
        input.signal,
        (error) => {
          const fence = { fenced: false };
          const terminalization = dispatchSettled
            .then(() => this.terminalizeCancelledAuthorization(
              entry,
              input.toolCallId,
              error.message,
              fence,
            ));
          this.trackBackgroundTask({
            kind: "authorizationTerminalization",
            runId,
            turnId: input.turnId,
            promise: terminalization,
            fence,
          }, (cleanupError) => this.reportBackgroundError(cleanupError, {
              runId,
              turnId: input.turnId,
            }));
        },
      );
      if (input.signal.aborted) {
        markDispatchSettled();
        return pendingDecision;
      }
      let result;
      try {
        result = await this.dispatch(entry, {
          type: "toolRequested",
          toolCallId: input.toolCallId,
          turnId: input.turnId,
          name: canonical.toolName,
          input: canonicalInput,
          inputDigest: digestScenarioValue(canonicalInput),
          requiresUserDecision: true,
        });
      } catch (error) {
        this.#authorizationWaiter.fail(
          runId,
          input.toolCallId,
          error instanceof Error ? error : new Error(String(error)),
        );
        await pendingDecision.catch(() => undefined);
        throw error;
      } finally {
        markDispatchSettled();
      }
      if (result.status === "userDecisionRequired") return pendingDecision;

      const immediateDecision = result.status === "allowed"
        ? { decision: "approve" as const, reason: result.reason ?? null }
        : {
            decision: "deny" as const,
            reason: result.reason ?? (result.status === "denied"
              ? "Tool use denied."
              : "Canonical tool authorization failed."),
          };
      if (!this.#authorizationWaiter.settle(runId, input.toolCallId, immediateDecision)) {
        return pendingDecision;
      }
      return pendingDecision;
    };
  }

  private async terminalizeCancelledAuthorization(
    entry: ProviderRun,
    toolCallId: string,
    reason: string,
    fence: { fenced: boolean },
  ): Promise<void> {
    const canCommit = (): boolean => !fence.fenced && this.isAttached(entry);
    if (!canCommit()) return;
    const snapshot = await this.runtime.snapshot(entry.runId);
    if (!canCommit()) return;
    const tool = snapshot.toolCalls.find((candidate) => candidate.id === toolCallId);
    if (!tool || isTerminalToolStatus(tool.status)) return;
    try {
      if (!canCommit()) return;
      await this.dispatch(entry, { type: "toolCancelled", toolCallId, error: reason });
    } catch (error) {
      if (!canCommit()) return;
      const latest = await this.runtime.snapshot(entry.runId);
      if (!canCommit()) return;
      const latestTool = latest.toolCalls.find((candidate) => candidate.id === toolCallId);
      if (!latestTool || isTerminalToolStatus(latestTool.status)) return;
      throw error;
    }
  }

  private async settleToolDecision(
    runId: string,
    toolCallId: string,
    decision: ToolDecision,
    reason: string | null,
  ): Promise<"settled" | "providerDetached"> {
    const entry = this.#runs.get(runId);
    if (!entry || entry.tearingDown) return "providerDetached";
    if (!this.#authorizationWaiter.settle(runId, toolCallId, { decision, reason })) {
      return "providerDetached";
    }
    return "settled";
  }

  private async cancel(runId: string, turnId: string | null): Promise<void> {
    const entry = this.requiredRun(runId);
    if (turnId === null) {
      const failures = await this.teardownProviderRun(entry, {
        lifecycleCommand: { type: "cancelRun" },
        skipLifecycleWhenTerminal: false,
        fallbackCancellationReason: "Provider run cancelled",
        pendingToolReason: null,
      });
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to cancel provider run: ${runId}`);
      }
      return;
    }
    const activeTurn = entry.activeTurn?.turnId === turnId ? entry.activeTurn : null;
    activeTurn?.controller.abort();
    this.#authorizationWaiter.cancelTurn(runId, turnId, "Provider turn cancelled");
    if (activeTurn) this.runtime.cancelActiveEffects(runId, "Provider turn cancelled");
    const settlement = activeTurn
      ? await this.waitForSettlement(activeTurn.promise)
      : null;
    const providerTimedOut = settlement !== null && this.providerSettlementTimedOut(settlement);
    const failures: unknown[] = [];
    if (providerTimedOut) {
      entry.tearingDown = true;
      const disposal = this.disposeRunner(entry);
      await this.collectSettlementFailure(disposal, failures);
    }
    try {
      await this.cancelPendingTools(entry, turnId, "Provider turn cancelled");
    } catch (error) {
      failures.push(error);
    }
    const terminalizationTimeouts = await this.waitForBackgroundTasks(
      (task) =>
        task.kind === "authorizationTerminalization" &&
        task.runId === runId &&
        task.turnId === turnId,
      failures,
    );
    const cleanupTimedOut = providerTimedOut || terminalizationTimeouts.length > 0;
    if (terminalizationTimeouts.length > 0 && !entry.tearingDown) {
      entry.tearingDown = true;
      await this.collectSettlementFailure(this.disposeRunner(entry), failures);
    }
    if (cleanupTimedOut) {
      try {
        await this.dispatch(entry, { type: "cancelRun" });
      } catch (error) {
        failures.push(error);
        this.runtime.cancelActiveEffects(entry.runId, "Provider detached after cancellation timeout");
      }
      if (this.#runs.get(entry.runId) === entry) this.#runs.delete(entry.runId);
      await this.recordProviderCleanupTimeout(
        entry,
        providerTimedOut
          ? `cancelling turn ${turnId}`
          : `waiting for authorization terminalization while cancelling turn ${turnId}`,
        failures,
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to cancel provider turn: ${runId}/${turnId}`);
    }
  }

  private async close(runId: string): Promise<void> {
    const entry = this.requiredRun(runId);
    const failures = await this.teardownProviderRun(entry, {
      lifecycleCommand: { type: "closeRun" },
      skipLifecycleWhenTerminal: false,
      fallbackCancellationReason: "Provider run closing",
      pendingToolReason: null,
    });
    if (failures.length > 0) throw new AggregateError(failures, `Failed to close provider run: ${runId}`);
  }

  public async dispose(): Promise<void> {
    const entries = [...this.#runs.values()];
    const failures = (await Promise.all(entries.map((entry) => this.teardownProviderRun(entry, {
      lifecycleCommand: { type: "cancelRun" },
      skipLifecycleWhenTerminal: true,
      fallbackCancellationReason: "Provider manager disposed",
      pendingToolReason: "Provider manager disposed",
    })))).flat();
    const backgroundTimeouts = await this.waitForBackgroundTasks(() => true, failures);
    if (backgroundTimeouts.length > 0) {
      await this.recordBackgroundTaskTimeouts(backgroundTimeouts, "disposing the provider manager", failures);
      failures.push(new ProviderSettlementTimeoutError(
        "Provider background task settlement timed out while disposing the provider manager",
      ));
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to dispose provider runs");
  }

  private teardownProviderRun(
    entry: ProviderRun,
    options: ProviderRunTeardownOptions,
  ): Promise<unknown[]> {
    if (entry.teardownPromise) return entry.teardownPromise;
    entry.tearingDown = true;
    const teardown = this.performProviderRunTeardown(entry, options);
    entry.teardownPromise = teardown;
    return teardown;
  }

  private async performProviderRunTeardown(
    entry: ProviderRun,
    options: ProviderRunTeardownOptions,
  ): Promise<unknown[]> {
    const failures = [...(options.initialFailures ?? [])];
    const activeTurn = entry.activeTurn;
    activeTurn?.controller.abort();
    this.#authorizationWaiter.cancelRun(
      entry.runId,
      options.pendingToolReason ?? options.fallbackCancellationReason,
    );
    if (options.lifecycleCommand) {
      try {
        const shouldDispatch = !options.skipLifecycleWhenTerminal ||
          !isTerminalRunStatus((await this.runtime.snapshot(entry.runId)).status);
        if (shouldDispatch) await this.dispatch(entry, options.lifecycleCommand);
      } catch (error) {
        failures.push(error);
        this.runtime.cancelActiveEffects(entry.runId, options.fallbackCancellationReason);
      }
    }
    if (options.pendingToolReason) {
      try {
        await this.cancelPendingTools(entry, null, options.pendingToolReason);
      } catch (error) {
        failures.push(error);
      }
    }
    const terminalizationTimeouts = await this.waitForBackgroundTasks(
      (task) => task.kind === "authorizationTerminalization" && task.runId === entry.runId,
      failures,
    );
    let timedOut = terminalizationTimeouts.length > 0;
    try {
      const disposal = this.disposeRunner(entry);
      timedOut = (await this.collectSettlementFailure(disposal, failures)) || timedOut;
      if (activeTurn) {
        timedOut = (await this.collectSettlementFailure(activeTurn.promise, failures)) || timedOut;
      }
    } finally {
      if (this.#runs.get(entry.runId) === entry) this.#runs.delete(entry.runId);
    }
    if (timedOut) {
      await this.recordProviderCleanupTimeout(entry, "tearing down the provider run", failures);
    }
    return failures;
  }

  private disposeRunner(entry: ProviderRun): Promise<unknown> {
    try {
      return Promise.resolve(entry.runner.dispose?.());
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private async waitForSettlement(promise: Promise<unknown>): Promise<ProviderSettlement> {
    const settlement = await waitForProviderSettlement(promise, this.#providerSettlementTimeoutMs);
    if (this.providerSettlementTimedOut(settlement)) {
      for (const task of this.#backgroundTasks) {
        if (task.promise === promise) this.#backgroundTasks.delete(task);
      }
    }
    return settlement;
  }

  private trackBackgroundTask(
    task: ProviderBackgroundTask,
    onRejected: (error: unknown) => void,
  ): void {
    this.#backgroundTasks.add(task);
    void task.promise.then(
      () => this.#backgroundTasks.delete(task),
      (error: unknown) => {
        this.#backgroundTasks.delete(task);
        onRejected(error);
      },
    );
  }

  private async waitForBackgroundTasks(
    matches: (task: ProviderBackgroundTask) => boolean,
    failures: unknown[],
  ): Promise<ProviderBackgroundTask[]> {
    const tasks = [...this.#backgroundTasks].filter(matches);
    const settlements = await Promise.all(tasks.map((task) => this.waitForSettlement(task.promise)));
    const timedOut: ProviderBackgroundTask[] = [];
    settlements.forEach((settlement, index) => {
      const task = tasks[index]!;
      if (this.providerSettlementTimedOut(settlement)) {
        if (task.fence) task.fence.fenced = true;
        timedOut.push(task);
      } else if (settlement.status === "rejected") {
        failures.push(settlement.error);
      }
    });
    return timedOut;
  }

  private async recordBackgroundTaskTimeouts(
    tasks: readonly ProviderBackgroundTask[],
    operation: string,
    failures: unknown[],
  ): Promise<void> {
    for (const runId of new Set(tasks.map((task) => task.runId))) {
      try {
        await this.runtime.recordDiagnostic(
          runId,
          `Provider cleanup timed out while ${operation}; provider detached`,
          "providerShutdown",
        );
      } catch (error) {
        failures.push(error);
      }
    }
  }

  private async collectSettlementFailure(
    promise: Promise<unknown>,
    failures: unknown[],
  ): Promise<boolean> {
    const settlement = await this.waitForSettlement(promise);
    if (settlement.status === "rejected" && !this.providerSettlementTimedOut(settlement)) {
      failures.push(settlement.error);
    }
    return this.providerSettlementTimedOut(settlement);
  }

  private providerSettlementTimedOut(settlement: ProviderSettlement): boolean {
    return settlement.status === "timedOut" || (
      settlement.status === "rejected" && settlement.error instanceof ProviderSettlementTimeoutError
    );
  }

  private async recordProviderCleanupTimeout(
    entry: ProviderRun,
    operation: string,
    failures: unknown[],
  ): Promise<void> {
    try {
      await this.runtime.recordDiagnostic(
        entry.runId,
        `Provider cleanup timed out while ${operation}; provider detached`,
        "providerShutdown",
      );
    } catch (error) {
      failures.push(error);
      this.reportBackgroundError(error, {
        runId: entry.runId,
        turnId: entry.activeTurn?.turnId ?? "provider-shutdown",
      });
    }
  }

  private async cancelPendingTools(
    entry: ProviderRun,
    turnId: string | null,
    reason: string,
  ): Promise<void> {
    const snapshot = await this.runtime.snapshot(entry.runId);
    const pending = snapshot.toolCalls.filter((tool) =>
      !isTerminalToolStatus(tool.status) &&
      (turnId === null || tool.turnId === turnId)
    );
    for (const tool of pending) {
      this.#authorizationWaiter.fail(
        entry.runId,
        tool.id,
        new OperationCancelledError(reason),
      );
      await this.dispatch(entry, { type: "toolCancelled", toolCallId: tool.id, error: reason });
    }
  }

  private reportBackgroundError(error: unknown, context: { runId: string; turnId: string }): void {
    reportBackgroundError({
      error,
      context,
      onBackgroundError: this.options.onBackgroundError,
      renderMessage: (failure, details) =>
        `Provider background turn failed for ${details.runId}/${details.turnId}: ${errorMessage(failure)}`,
      reportingFailurePrefix: "Provider background error reporting failed",
    });
  }

  private requiredRun(runId: string): ProviderRun {
    const entry = this.#runs.get(runId);
    if (!entry || entry.tearingDown) throw new Error(`Unknown provider run: ${runId}`);
    return entry;
  }

  private isAttached(entry: ProviderRun): boolean {
    return this.#runs.get(entry.runId) === entry && !entry.tearingDown;
  }

  private dispatch(
    entry: ProviderRun,
    payload: ScenarioCommandPayload,
    nativeSessionId = entry.nativeSessionId,
  ) {
    return this.runtime.dispatch(createScenarioCommandEnvelope({
      runId: entry.runId,
      source: {
        kind: "providerSdk",
        adapter: entry.adapter,
        provider: entry.provider,
        nativeSessionId,
      },
      payload,
    }));
  }
}

function providerObservedNativeSessionId(payload: ScenarioCommandPayload): string | null {
  if (payload.type !== "providerStateObserved") return null;
  const data = payload.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const parsed = idSchema.safeParse(data.nativeSessionId);
  return parsed.success ? parsed.data : null;
}

function isFatalProviderError(payload: ScenarioCommandPayload): boolean {
  if (payload.type !== "runtimeErrorObserved") return false;
  const data = payload.data;
  return !(
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    data.recoverable === true
  );
}

function providerCapabilities(adapter: SdkRuntime): typeof FULL_RUN_CAPABILITIES {
  return {
    ...FULL_RUN_CAPABILITIES,
    interactiveToolDecisions: adapter === "claude",
  };
}
