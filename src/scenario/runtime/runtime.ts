import { randomUUID } from "crypto";
import { errorMessage } from "../../utils/output.js";
import {
  reportBackgroundError,
  type BackgroundErrorCallback,
} from "../../utils/background-errors.js";
import {
  isScenarioEffectLifecycleCommand,
  scenarioCommandSchema,
  type ScenarioCommand,
  type ScenarioCommandPayload,
  type NativeTranscriptData,
} from "../protocol/commands.js";
import {
  createScenarioCommandEnvelope,
  type ScenarioCommandEnvelopeInput,
} from "../protocol/command-envelope.js";
import {
  artifactStringReference,
  escapeArtifactLiteralValue,
  isReservedArtifactValue,
  type ArtifactRef,
  type ArtifactValueReference,
} from "../protocol/artifacts.js";
import { canonicalJson, canonicalJsonEqual } from "../protocol/canonical-json.js";
import { toJsonValue, type JsonValue } from "../protocol/common.js";
import { assertScenarioCommandDigests, digestScenarioValue } from "../protocol/digest.js";
import {
  scenarioEffectProjectionRecordSchema,
  scenarioEffectStateChangeSchema,
  type ScenarioEffectProjection,
} from "../protocol/effects.js";
import { feedbackEntrySchema, validateFeedbackNote, type FeedbackEntry } from "../protocol/feedback.js";
import {
  eventBatchSchema,
  type EventBatch,
  type ScenarioEventType,
  type ScenarioRecord,
} from "../protocol/records.js";
import { scenarioProtocolSchemaDigest } from "../protocol/schema.js";
import {
  isPendingEffectStatus,
  isTerminalMessageStatus,
  isTerminalRunStatus,
  isTerminalToolStatus,
  runtimeErrorSchema,
  scenarioSnapshotSchema,
  type ScenarioSnapshot,
} from "../protocol/snapshot.js";
import { runArtifactsDir } from "../store/paths.js";
import { RunRegistry } from "../store/run-registry.js";
import { RunStore, type CommittedRunBatch, type OpenRun } from "../store/run-store.js";
import { ArtifactStore } from "../store/artifact-store.js";
import { runManifestSchema, type RunManifest } from "../store/types.js";
import {
  emptyScenarioSnapshot,
  reduceScenarioRecords,
  scenarioJournalRevision,
} from "./reducer.js";
import {
  ScenarioEffectCancellationError,
  type PlannedScenarioEffect,
  type ScenarioEffectExecutor,
  type ScenarioEffectPlanner,
  type ScenarioEffectRequest,
  type ScenarioEffectResult,
} from "./effects.js";
import {
  redactScenarioValue,
  sanitizeScenarioValueForPersistence,
} from "./redaction.js";
import { hydrateArtifactValues, trustedArtifactValueReferences } from "./artifact-values.js";
import { FeedbackTargetConflictError, SnapshotRevisionConflictError } from "./errors.js";
import { scenarioTerminalResultSchema, type ScenarioTerminalResult } from "./results.js";
import {
  canonicalToolRequestedRecord,
  observedToolLifecycleRecords,
  type ObservedToolAuthorization,
} from "./tool-lifecycle.js";
import type { ScenarioStateSlicePolicy } from "./state-slice-policy.js";
import type {
  ScenarioCommandExtensionHandler,
  ScenarioCommandExtensionMutation,
} from "./command-extension.js";

export type ScenarioRuntimeOptions = {
  root: string;
  store?: RunStore;
  registry?: RunRegistry;
  clock?: () => Date;
  idFactory?: () => string;
  effectExecutor?: ScenarioEffectExecutor;
  effectPlanner?: ScenarioEffectPlanner;
  extensionHandler?: ScenarioCommandExtensionHandler;
  stateSlicePolicy?: ScenarioStateSlicePolicy;
  maximumInlineBytes?: number;
  redactionPaths?: readonly string[];
  effectClaimLeaseMs?: number;
  effectClaimHeartbeatMs?: number;
  onBackgroundError?: BackgroundErrorCallback<ScenarioRuntimeBackgroundErrorContext>;
};

export type ScenarioRuntimeBackgroundErrorContext = {
  runId: string;
  operation: "diagnosticPublication";
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;
export type PublishedEventBatch = DeepReadonly<EventBatch>;
export type PublishedScenarioSnapshot = DeepReadonly<ScenarioSnapshot>;
export type ScenarioSubscriber = (
  batch: PublishedEventBatch,
  snapshot: PublishedScenarioSnapshot,
) => void;
type SemanticRecord = {
  eventType: ScenarioEventType;
  payload: Record<string, JsonValue>;
  entityRef?: { kind: string; id: string };
  visibility?: ScenarioRecord["visibility"];
};
type SemanticResult = {
  records: SemanticRecord[];
  result: ScenarioTerminalResult;
  feedback?: FeedbackEntry;
};
type DispatchOnceResult = {
  result: ScenarioTerminalResult;
};
type StartRunCommand = ScenarioCommand & {
  payload: Extract<ScenarioCommandPayload, { type: "startRun" }>;
};
type EffectOrigin = Pick<ScenarioCommand, "runId" | "source"> & {
  commandId: string;
  correlationId: string;
};
type OutboxEffect = {
  request: ScenarioEffectRequest;
  origin: EffectOrigin;
  status: "requested" | "started";
  claimId: string | null;
  startedAt: string | null;
  claimRenewedAt: string | null;
  observedSnapshotRevision: number;
};
type CapturedLargeValues = {
  references: Map<string, ArtifactRef>;
  created: ArtifactRef[];
  store: ArtifactStore;
};

export class ScenarioRuntime {
  private readonly store: RunStore;
  private readonly registry: RunRegistry;
  private readonly subscribers = new Map<string, Set<ScenarioSubscriber>>();
  private readonly activeEffects = new Map<string, Map<string, AbortController>>();
  private readonly effectCancellationReasons = new WeakMap<AbortController, string>();
  private readonly clock: () => Date;
  private readonly idFactory: () => string;
  private readonly largeValues = new Map<string, Map<string, ArtifactRef>>();

  public constructor(private readonly options: ScenarioRuntimeOptions) {
    this.store = options.store ?? new RunStore(options.root);
    this.registry = options.registry ?? new RunRegistry(options.root);
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  public async dispatch(commandInput: ScenarioCommand): Promise<ScenarioTerminalResult> {
    return this.commitCommand(commandInput, true);
  }

  /**
   * Commit one caller-supplied command without synthesizing effect lifecycle
   * commands. Contract importers use this to replay an explicit journal stream;
   * production dispatch continues to drain the durable effect outbox.
   */
  public async replayCommand(commandInput: ScenarioCommand): Promise<ScenarioTerminalResult> {
    return this.commitCommand(commandInput, false);
  }

  private async commitCommand(
    commandInput: ScenarioCommand,
    drainEffects: boolean,
  ): Promise<ScenarioTerminalResult> {
    const command = scenarioCommandSchema.parse(commandInput);
    assertScenarioCommandDigests(command);
    if (command.payload.type === "extensionCommand") {
      this.options.extensionHandler?.validate?.(command as ScenarioCommand & {
        payload: Extract<ScenarioCommand["payload"], { type: "extensionCommand" }>;
      });
    }
    assertScenarioSchemaDigest(command);
    try {
      if (command.payload.type === "startRun" && !(await this.store.exists(command.runId))) {
        await this.createRun(command);
      }
      const committed = await this.dispatchOnce(command);
      if (command.payload.type === "cancelRun" || command.payload.type === "closeRun") {
        this.abortRunEffects(
          command.runId,
          command.payload.type === "cancelRun" ? "Run cancelled" : "Run closed",
        );
      }
      if (
        command.payload.type === "runtimeErrorObserved" &&
        normalizeRuntimeError(command.payload.data).recoverable !== true
      ) {
        this.abortRunEffects(command.runId, "Run failed");
      }
      if (!drainEffects) return committed.result;
      const effectResults = await this.drainPendingEffects(command.runId);
      return effectResults.get(command.commandId) ?? committed.result;
    } finally {
      this.largeValues.delete(commandArtifactScope(command.runId, command.commandId));
    }
  }

  /** Create or repair a run's initial transition, tolerating equivalent concurrent callers. */
  public async ensureRunStarted(commandInput: ScenarioCommand): Promise<ScenarioTerminalResult> {
    const parsed = scenarioCommandSchema.parse(commandInput);
    assertScenarioCommandDigests(parsed);
    assertScenarioSchemaDigest(parsed);
    if (parsed.payload.type !== "startRun") throw new Error("ensureRunStarted requires a startRun command");
    const command = parsed as StartRunCommand;
    if (!(await this.store.exists(command.runId))) {
      try {
        await this.createRun(command);
      } catch (error) {
        if (!(await this.store.exists(command.runId))) throw error;
      }
    }
    const opened = await this.openAndPublish(command.runId);
    if (!equivalentRunStart(command, opened.manifest, this.options.redactionPaths)) {
      throw new Error(`Run initializer conflicts with existing identity: ${command.runId}`);
    }
    if (opened.snapshot.status === "running") {
      return { status: "accepted" };
    }
    try {
      return await this.dispatch(command);
    } catch (error) {
      const current = await this.openAndPublish(command.runId);
      if (
        current.snapshot.status === "running" &&
        equivalentRunStart(command, current.manifest, this.options.redactionPaths)
      ) {
        return { status: "accepted" };
      }
      throw error;
    }
  }

  public async snapshot(runId: string): Promise<ScenarioSnapshot> {
    return (await this.openAndPublish(runId)).snapshot;
  }

  public async recordsAfter(runId: string, afterSeq: number): Promise<ScenarioRecord[]> {
    return (await this.openAndPublish(runId)).records.filter((record) => record.recordSeq > afterSeq);
  }

  /** Return one revision-consistent journal and snapshot view from a single locked store read. */
  public async canonicalView(runId: string): Promise<{
    records: ScenarioRecord[];
    snapshot: ScenarioSnapshot;
  }> {
    const run = await this.openAndPublish(runId);
    return { records: run.records, snapshot: run.snapshot };
  }

  /** Resolve one immutable feedback revision from canonical journal history. */
  public async feedbackById(runId: string, feedbackId: string): Promise<FeedbackEntry | undefined> {
    const records = (await this.openAndPublish(runId)).records;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record.eventType !== "feedback.changed") continue;
      const parsed = feedbackEntrySchema.safeParse(record.payload.feedback);
      if (parsed.success && parsed.data.feedbackId === feedbackId) return parsed.data;
    }
    return undefined;
  }

  /** Persist an internal failure without exposing it through a public protocol response. */
  public async recordDiagnostic(runId: string, message: string, source: string): Promise<void> {
    await this.recordPostCommitDiagnostics(this.createCommand({
      runId,
      source: { kind: "gateway" },
      payload: { type: "runtimeErrorObserved", data: { recoverable: true } },
    }), [{ message, source }]);
  }

  /** Resume durable requested effects and expired started-effect claims. */
  public async recoverPendingEffects(runId: string): Promise<void> {
    await this.drainPendingEffects(runId);
  }

  private async drainPendingEffects(runId: string): Promise<Map<string, ScenarioTerminalResult>> {
    const results = new Map<string, ScenarioTerminalResult>();
    while (true) {
      const run = await this.openAndPublish(runId);
      if (run.snapshot.status !== "running") return results;
      const pending = await Promise.all(run.snapshot.effects
        .filter((effect) => isPendingEffectStatus(effect.status))
        .map((effect) => this.outboxEffect(run, effect)));
      let progressed = false;
      for (const effect of pending) {
        if (this.activeEffects.get(runId)?.has(effect.request.effectId)) continue;
        const result = await this.claimAndExecuteEffect(effect);
        if (!result) continue;
        progressed = true;
        results.set(effect.origin.commandId, result);
      }
      if (!progressed) return results;
    }
  }

  private async outboxEffect(
    run: OpenRun,
    effect: ScenarioSnapshot["effects"][number],
  ): Promise<OutboxEffect> {
    const requestRecord = run.records.find((record) =>
      record.eventType === "effect.requested" && record.payload.effectId === effect.effectId
    );
    if (!requestRecord) throw new Error(`Effect request record is missing: ${effect.effectId}`);
    const acceptedRequest = run.records.find((record) =>
      record.eventType === "command.accepted" && record.commandId === requestRecord.commandId
    );
    const capturedRequest = scenarioCommandSchema.safeParse(acceptedRequest?.payload.command);
    const originSource = capturedRequest.success ? capturedRequest.data.source : run.manifest.source;
    const artifacts = new Map(run.snapshot.artifacts.map((artifact) => [artifact.digest, artifact]));
    const trustedReferences = trustedArtifactValueReferences(run.records);
    const parameters = await hydrateArtifactValues(
      this,
      run.snapshot.runId,
      effect.parameters,
      artifacts,
      new Map(),
      trustedReferences,
    );
    const priorRecords = run.records.filter((record) => record.recordSeq < requestRecord.recordSeq);
    const projected = reduceScenarioRecords(
      emptyScenarioSnapshot(run.manifest),
      priorRecords,
      scenarioJournalRevision(priorRecords),
    );
    const hydratedSnapshot = scenarioSnapshotSchema.parse(await hydrateArtifactValues(
      this,
      run.snapshot.runId,
      toJsonValue(projected),
      artifacts,
      new Map(),
      trustedReferences,
    ));
    const executionContext = toJsonValue({ snapshot: hydratedSnapshot, parameters });
    return {
      request: {
        effectId: effect.effectId,
        effectType: effect.effectType,
        parameters,
        executionContext,
      },
      origin: {
        runId: run.snapshot.runId,
        commandId: requestRecord.commandId,
        correlationId: requestRecord.correlationId ?? requestRecord.commandId,
        source: originSource,
      },
      status: effect.status as OutboxEffect["status"],
      claimId: effect.claimId,
      startedAt: effect.startedAt,
      claimRenewedAt: effect.claimRenewedAt,
      observedSnapshotRevision: run.snapshot.revision,
    };
  }

  private async claimAndExecuteEffect(effect: OutboxEffect): Promise<ScenarioTerminalResult | null> {
    const claimId = this.idFactory();
    const controller = this.registerEffect(effect.origin.runId, effect.request.effectId);
    let heartbeat: { stop(): Promise<void> } | undefined;
    try {
      let observed = {
        status: effect.status,
        claimId: effect.claimId,
        startedAt: effect.startedAt,
        claimRenewedAt: effect.claimRenewedAt,
        snapshotRevision: effect.observedSnapshotRevision,
      };
      let claimed = false;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        if (observed.status === "started" && !isEffectClaimExpired(
          observed,
          this.clock().getTime(),
          this.options.effectClaimLeaseMs ?? 30_000,
        )) return null;
        try {
          await this.commitInternalCommand({
            ...this.effectLifecycleCommand(effect.origin, {
              type: "effectStarted",
              effectId: effect.request.effectId,
              effectType: effect.request.effectType,
              claimId,
              ...(observed.claimId === null ? {} : { previousClaimId: observed.claimId }),
            }),
            expectedSnapshotRevision: observed.snapshotRevision,
          });
          claimed = true;
          break;
        } catch (error) {
          const snapshot = await this.snapshot(effect.origin.runId);
          const current = snapshot.effects.find((candidate) =>
            candidate.effectId === effect.request.effectId
          );
          if (current?.status === "started" && current.claimId === claimId) {
            claimed = true;
            break;
          }
          if (!(error instanceof SnapshotRevisionConflictError)) {
            if (!current || !isPendingEffectStatus(current.status) || current.claimId !== observed.claimId) {
              return null;
            }
            throw error;
          }
          if (!current || (current.status !== "requested" && current.status !== "started")) return null;
          observed = {
            status: current.status,
            claimId: current.claimId,
            startedAt: current.startedAt,
            claimRenewedAt: current.claimRenewedAt,
            snapshotRevision: snapshot.revision,
          };
        }
      }
      if (!claimed) throw new Error(`Effect claim did not converge: ${effect.request.effectId}`);

      heartbeat = this.startEffectClaimHeartbeat(effect.origin, effect.request, claimId, controller);
      let completedCommand: ScenarioCommand;
      try {
        const effectResult = await this.executeEffect({
          ...effect.request,
          fencingToken: claimId,
          signal: controller.signal,
          reportProgress: (progress) => this.reportEffectProgress(
            effect.origin,
            effect.request.effectId,
            claimId,
            progress,
            controller.signal,
          ),
        });
        completedCommand = scenarioCommandSchema.parse(this.effectLifecycleCommand(effect.origin, {
          type: "effectResultSupplied",
          effectId: effect.request.effectId,
          claimId,
          result: effectResult.result,
          metadata: effectResult.metadata ?? {},
          ...(effectResult.projection === undefined ? {} : { projection: effectResult.projection }),
        }));
      } catch (error) {
        if (controller.signal.aborted) {
          await this.recordEffectCancellation(effect.origin, effect.request, claimId, controller);
          return { status: "cancelled", reason: "Effect cancelled" };
        }
        if (error instanceof ScenarioEffectCancellationError) {
          return await this.commitInternalCommand(this.effectLifecycleCommand(effect.origin, {
            type: "effectCancelled",
            effectId: effect.request.effectId,
            effectType: effect.request.effectType,
            claimId,
            reason: error.reason,
          }));
        }
        try {
          return await this.commitInternalCommand(this.effectLifecycleCommand(effect.origin, {
            type: "effectFailed",
            effectId: effect.request.effectId,
            effectType: effect.request.effectType,
            claimId,
            error: errorMessage(error),
          }));
        } catch (terminalError) {
          const current = (await this.snapshot(effect.origin.runId)).effects.find((candidate) =>
            candidate.effectId === effect.request.effectId
          );
          if (current?.claimId !== claimId || !isPendingEffectStatus(current.status)) return null;
          throw terminalError;
        }
      }
      if (controller.signal.aborted) {
        await this.recordEffectCancellation(effect.origin, effect.request, claimId, controller);
        return { status: "cancelled", reason: "Effect cancelled" };
      }
      try {
        return await this.commitInternalCommand(completedCommand);
      } catch (persistenceError) {
        const committed = await this.committedEffectResult(completedCommand);
        if (committed) return committed;
        throw persistenceError;
      }
    } finally {
      await heartbeat?.stop();
      this.unregisterEffect(effect.origin.runId, effect.request.effectId, controller);
    }
  }

  private startEffectClaimHeartbeat(
    origin: EffectOrigin,
    request: ScenarioEffectRequest,
    claimId: string,
    controller: AbortController,
  ): { stop(): Promise<void> } {
    const leaseMs = this.options.effectClaimLeaseMs ?? 30_000;
    const intervalMs = Math.max(1, Math.min(
      this.options.effectClaimHeartbeatMs ?? Math.floor(leaseMs / 3),
      Math.max(1, leaseMs - 1),
    ));
    let stopped = false;
    let renewal = Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (): void => {
      timer = setTimeout(() => {
        renewal = renew();
      }, intervalMs);
      timer.unref();
    };
    const renew = async (): Promise<void> => {
      if (stopped || controller.signal.aborted) return;
      try {
        await this.commitInternalCommand(this.effectLifecycleCommand(origin, {
          type: "effectClaimRenewed",
          effectId: request.effectId,
          effectType: request.effectType,
          claimId,
        }));
      } catch (error) {
        if (stopped) return;
        this.effectCancellationReasons.set(
          controller,
          `Effect claim renewal failed: ${errorMessage(error)}`,
        );
        controller.abort();
      }
      if (!stopped && !controller.signal.aborted) schedule();
    };
    schedule();
    return {
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        if (timer) clearTimeout(timer);
        await renewal;
      },
    };
  }

  private effectLifecycleCommand(
    origin: EffectOrigin,
    payload: ScenarioCommand["payload"],
  ): ScenarioCommand {
    return this.createCommand({
      runId: origin.runId,
      source: origin.source,
      correlationId: origin.correlationId,
      causationId: origin.commandId,
      payload,
    });
  }

  /** Commit runtime-owned effect lifecycle state without recursively draining the durable outbox. */
  private commitInternalCommand(command: ScenarioCommand): Promise<ScenarioTerminalResult> {
    return this.replayCommand(command);
  }

  private async committedEffectResult(command: ScenarioCommand): Promise<ScenarioTerminalResult | null> {
    try {
      const { run } = await this.store.open(command.runId);
      const accepted = run.records.find((record) =>
        record.commandId === command.commandId && record.eventType === "command.accepted"
      );
      if (accepted?.payload.commandDigest !== commandIdentityDigest(command)) return null;
      return scenarioTerminalResultSchema.parse(accepted.payload.result);
    } catch {
      return null;
    }
  }

  private createCommand(input: ScenarioCommandEnvelopeInput): ScenarioCommand {
    return createScenarioCommandEnvelope(input, {
      idFactory: this.idFactory,
      clock: this.clock,
    });
  }

  public async committedBatchesAfter(runId: string, afterSeq: number): Promise<EventBatch[]> {
    const { snapshot, records } = await this.openAndPublish(runId);
    if (afterSeq > snapshot.lastRecordSeq) {
      throw new Error(`Cursor ${afterSeq} exceeds last record ${snapshot.lastRecordSeq}`);
    }
    const groups: ScenarioRecord[][] = [];
    for (const record of records) {
      const current = groups.at(-1);
      if (!current || current[0]?.commandId !== record.commandId) groups.push([record]);
      else current.push(record);
    }
    const priorGroups = groups.filter((group) => (group.at(-1)?.recordSeq ?? 0) <= afterSeq).length;
    const pendingGroups = groups.slice(priorGroups);
    const first = pendingGroups[0]?.[0];
    if (!first) return [];
    if (first.recordSeq !== afterSeq + 1) {
      throw new Error(`Cursor ${afterSeq} splits or gaps a committed batch at ${first.recordSeq}`);
    }
    const baseRevision = Math.max(0, snapshot.revision - pendingGroups.length);
    return pendingGroups.map((recordsForCommand, index) => eventBatchSchema.parse({
      runId,
      fromSeq: recordsForCommand[0]?.recordSeq,
      toSeq: recordsForCommand.at(-1)?.recordSeq,
      baseSnapshotRevision: baseRevision + index,
      resultingSnapshotRevision: baseRevision + index + 1,
      records: recordsForCommand,
    }));
  }

  public async readArtifact(
    runId: string,
    requested: ArtifactRef,
    maximumBytes: number,
  ): Promise<{ artifact: ArtifactRef; bytes: Uint8Array }> {
    const snapshot = await this.snapshot(runId);
    const artifact = snapshot.artifacts.find((candidate) =>
      candidate.artifactId === requested.artifactId && candidate.digest === requested.digest
    );
    if (!artifact) throw new Error("Artifact is not linked to the requested run");
    if (artifact.byteLength > maximumBytes) throw new Error("Artifact exceeds negotiated maximum size");
    const bytes = await new ArtifactStore(runArtifactsDir(runId, this.options.root)).get(artifact);
    return { artifact, bytes };
  }

  public async listRuns(): Promise<RunManifest[]> {
    const discovered = await this.registry.list();
    return Promise.all(discovered.map(async (manifest) =>
      (await this.openAndPublish(manifest.runId)).manifest
    ));
  }

  /** Initialize canonical state for fixture execution or a validated import. */
  public async initializeSeededRun(
    startCommandInput: ScenarioCommand,
    records: readonly ScenarioRecord[],
    snapshot?: ScenarioSnapshot,
  ): Promise<ScenarioSnapshot> {
    const startCommand = scenarioCommandSchema.parse(startCommandInput);
    assertScenarioCommandDigests(startCommand);
    assertScenarioSchemaDigest(startCommand);
    if (startCommand.payload.type !== "startRun") throw new Error("Seeded runs require a startRun command");
    if (await this.store.exists(startCommand.runId)) throw new Error(`Run already exists: ${startCommand.runId}`);
    const manifest = manifestForStartCommand(startCommand, this.options.redactionPaths);
    const created = await this.store.createSeeded(manifest, records, snapshot);
    await this.registry.append(manifest, "created");
    return created;
  }

  public subscribe(runId: string, subscriber: ScenarioSubscriber): () => void {
    const subscribers = this.subscribers.get(runId) ?? new Set<ScenarioSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(runId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(runId);
    };
  }

  /** Abort in-flight effects while keeping the run resumable for later commands. */
  public cancelActiveEffects(runId: string, reason = "Effect cancelled"): void {
    this.abortRunEffects(runId, reason);
  }

  private registerEffect(runId: string, effectId: string): AbortController {
    const controller = new AbortController();
    const effects = this.activeEffects.get(runId) ?? new Map<string, AbortController>();
    effects.get(effectId)?.abort();
    effects.set(effectId, controller);
    this.activeEffects.set(runId, effects);
    return controller;
  }

  private unregisterEffect(runId: string, effectId: string, controller: AbortController): void {
    const effects = this.activeEffects.get(runId);
    if (effects?.get(effectId) !== controller) return;
    effects.delete(effectId);
    if (effects.size === 0) this.activeEffects.delete(runId);
  }

  private abortRunEffects(runId: string, reason: string): void {
    for (const controller of this.activeEffects.get(runId)?.values() ?? []) {
      this.effectCancellationReasons.set(controller, reason);
      controller.abort();
    }
  }

  private async recordEffectCancellation(
    origin: EffectOrigin,
    request: ScenarioEffectRequest,
    claimId: string,
    controller: AbortController,
  ): Promise<void> {
    const snapshot = await this.snapshot(origin.runId);
    const effect = snapshot.effects.find((candidate) => candidate.effectId === request.effectId);
    if (effect?.status !== "started" || effect.claimId !== claimId) return;
    await this.commitInternalCommand(this.effectLifecycleCommand(origin, {
      type: "effectCancelled",
      effectId: request.effectId,
      effectType: request.effectType,
      claimId,
      reason: this.effectCancellationReasons.get(controller) ?? "Effect cancelled",
    }));
  }

  private async createRun(command: ScenarioCommand): Promise<void> {
    if (command.payload.type !== "startRun") throw new Error("Only startRun can create a run");
    const manifest = manifestForStartCommand(command, this.options.redactionPaths);
    await this.store.create(manifest, emptyScenarioSnapshot(manifest));
    await this.registry.append(manifest, "created");
  }

  private async dispatchOnce(command: ScenarioCommand): Promise<DispatchOnceResult> {
    let committedRecords: ScenarioRecord[] = [];
    let committedManifest: RunManifest | undefined;
    let artifactsNeedReconciliation = false;
    const transaction = await this.store.transact(command.runId, async (run) => {
      const prior = run.snapshot.commandResults[command.commandId];
      if (prior !== undefined) {
        assertCommandRetryMatches(command, run);
        return { records: [], value: scenarioTerminalResultSchema.parse(prior) };
      }
      if (command.expectedSnapshotRevision !== undefined && command.expectedSnapshotRevision !== run.snapshot.revision) {
        throw new SnapshotRevisionConflictError(command.expectedSnapshotRevision, run.snapshot.revision);
      }
      assertCommandCapabilities(command.payload, run.snapshot);
      assertRunLifecycle(command.payload, run.snapshot);
      const persistentCommand = scenarioCommandSchema.parse(sanitizeScenarioValueForPersistence(
        toJsonValue(command),
        [],
        { secretPaths: this.options.redactionPaths },
      ));
      const semantic = this.semanticRecords(persistentCommand, run);
      const capturedArtifacts = await this.captureLargeValues(persistentCommand);
      const artifactScope = commandArtifactScope(command.runId, command.commandId);
      if (capturedArtifacts.references.size > 0) {
        this.largeValues.set(artifactScope, capturedArtifacts.references);
      }
      artifactsNeedReconciliation = capturedArtifacts.created.length > 0;
      try {
        const result = semantic.result;
        const artifactRefs = [
          ...new Map(
            Array.from(this.largeValues.get(artifactScope)?.values() ?? [])
              .map((artifact) => [artifact.digest, artifact] as const),
          ).values(),
        ];
        committedRecords = [
          this.record(persistentCommand, run.snapshot.lastRecordSeq + 1, "command.accepted", {
            commandType: persistentCommand.payload.type,
            command: toJsonValue(persistentCommand),
            commandDigest: commandIdentityDigest(command),
            result: toJsonValue(result),
          }, undefined, commandVisibility(persistentCommand.payload)),
          ...artifactRefs
            .map((artifact, index) => this.record(
              persistentCommand,
              run.snapshot.lastRecordSeq + index + 2,
              "artifact.linked",
              { artifact: toJsonValue(artifact) },
              { kind: "artifact", id: artifact.artifactId },
              "artifactReference",
            )),
          ...semantic.records.map((record, index) => this.record(
            persistentCommand,
            run.snapshot.lastRecordSeq + index + 2 + artifactRefs.length,
            record.eventType,
            record.payload,
            record.entityRef,
            record.visibility ?? "localSensitive",
          )),
        ];
        const status = manifestStatus(command.payload, run.manifest.status);
        committedManifest = {
          ...run.manifest,
          adapter: command.source.adapter ?? run.manifest.adapter,
          provider: command.source.provider ?? run.manifest.provider,
          nativeSessionIds: command.source.nativeSessionId && !run.manifest.nativeSessionIds.includes(command.source.nativeSessionId)
            ? [...run.manifest.nativeSessionIds, command.source.nativeSessionId]
            : run.manifest.nativeSessionIds,
          status,
          updatedAt: command.recordedAt,
        };
        return {
          records: committedRecords,
          manifest: committedManifest,
          ...(semantic.feedback === undefined ? {} : { feedback: semantic.feedback }),
          value: result,
        };
      } catch (error) {
        await this.removeCreatedArtifacts(capturedArtifacts);
        artifactsNeedReconciliation = false;
        throw error;
      }
    }).catch(async (error: unknown) => {
      if (artifactsNeedReconciliation) {
        try {
          await this.openAndPublish(command.runId);
        } catch {
          // Preserve the transaction failure; a later canonical open retries artifact reconciliation.
        }
      }
      throw error;
    });
    artifactsNeedReconciliation = false;
    const subscriberFailures = this.publishCommittedBatches(command.runId, transaction.committedBatches);
    if (subscriberFailures.length > 0) {
      await this.recordSubscriberFailures(command, subscriberFailures);
    }
    if (committedRecords.length > 0) {
      if (committedManifest && shouldUpdateRegistry(command.payload)) {
        try {
          await this.registry.append(
            committedManifest,
            committedManifest.status === "closed" ? "closed" : "updated",
          );
        } catch (error) {
          await this.recordPostCommitDiagnostics(command, [{
            message: `Run registry publication failed: ${errorMessage(error)}`,
            source: "runRegistry",
          }]);
        }
      }
    }
    return { result: transaction.value };
  }

  private publishBatch(
    runId: string,
    batch: EventBatch,
    snapshot: ScenarioSnapshot,
  ): string[] {
    const failures: string[] = [];
    const subscribers = this.subscribers.get(runId);
    for (const subscriber of [...(subscribers ?? [])]) {
      try {
        subscriber(immutablePublication(batch), immutablePublication(snapshot));
      } catch (error) {
        subscribers?.delete(subscriber);
        failures.push(errorMessage(error));
      }
    }
    if (subscribers?.size === 0) this.subscribers.delete(runId);
    return failures;
  }

  private publishCommittedBatches(runId: string, committedBatches: readonly CommittedRunBatch[]): string[] {
    const failures: string[] = [];
    for (const committed of committedBatches) {
      const batch = eventBatchSchema.parse({
        runId,
        fromSeq: committed.records[0]?.recordSeq,
        toSeq: committed.records.at(-1)?.recordSeq,
        baseSnapshotRevision: committed.baseSnapshotRevision,
        resultingSnapshotRevision: committed.resultingSnapshotRevision,
        records: committed.records,
      });
      failures.push(...this.publishBatch(runId, batch, committed.snapshot));
    }
    return failures;
  }

  /** Open one canonical view and publish any recovery records committed by that read. */
  private async openAndPublish(runId: string): Promise<OpenRun> {
    const opened = await this.store.open(runId);
    const failures = this.publishCommittedBatches(runId, opened.committedBatches);
    if (failures.length === 0) return opened.run;
    const diagnosticCommand = this.createCommand({
      runId,
      source: { kind: "gateway" },
      payload: { type: "runtimeErrorObserved", data: { recoverable: true } },
    });
    await this.recordSubscriberFailures(diagnosticCommand, failures);
    return this.openAndPublish(runId);
  }

  private async recordSubscriberFailures(command: ScenarioCommand, failures: readonly string[]): Promise<void> {
    await this.recordPostCommitDiagnostics(command, failures.map((failure) => ({
      message: `Scenario subscriber failed: ${failure}`,
      source: "subscriber",
    })));
  }

  private async recordPostCommitDiagnostics(
    command: ScenarioCommand,
    failures: readonly { message: string; source: string }[],
  ): Promise<void> {
    const diagnosticCommand = this.createCommand({
      runId: command.runId,
      source: command.source,
      correlationId: command.correlationId ?? command.commandId,
      causationId: command.commandId,
      payload: {
        type: "runtimeErrorObserved",
        data: { failures: failures.map((failure) => failure.message) },
      },
    });
    const transaction = await this.store.transact(command.runId, async (run) => {
      const diagnosticRecords = failures.map((failure, index) => this.record(
        diagnosticCommand,
        run.snapshot.lastRecordSeq + index + 1,
        "store.diagnostic",
        { message: failure.message, source: failure.source, status: "recovered" },
        { kind: "stateSlice", id: "store.health" },
        "localSensitive",
      ));
      return {
        records: diagnosticRecords,
        manifest: { ...run.manifest, updatedAt: diagnosticCommand.recordedAt },
        value: undefined,
      };
    });
    const subscriberFailures = this.publishCommittedBatches(
      command.runId,
      transaction.committedBatches,
    );
    if (subscriberFailures.length > 0) {
      reportBackgroundError({
        error: new Error(subscriberFailures.join("; ")),
        context: { runId: command.runId, operation: "diagnosticPublication" },
        onBackgroundError: this.options.onBackgroundError,
        renderMessage: (error, context) =>
          `Scenario runtime background failure during ${context.operation} for ${context.runId}: ` +
          errorMessage(error),
        reportingFailurePrefix: "Scenario runtime background error reporting failed",
      });
    }
  }

  private semanticRecords(command: ScenarioCommand, run: OpenRun): SemanticResult {
    const payload = command.payload;
    switch (payload.type) {
      case "startRun":
        return {
          records: [
            { eventType: "run.started", payload: { schemaDigest: payload.schemaDigest }, visibility: "localSensitive" },
            {
              eventType: "capabilities.declared",
              payload: { capabilities: toJsonValue(payload.capabilities) },
              visibility: "public",
            },
            ...projectedMutationRecords(
              (this.options.stateSlicePolicy?.initialChanges?.() ?? []).map((change) => ({
                kind: "stateChange" as const,
                change,
              })),
              command,
              run,
              this.options.stateSlicePolicy,
            ),
          ],
          result: { status: "accepted" },
        };
      case "resumeRun":
        return simple("run.resumed", payload, { status: "accepted" }, "localSensitive");
      case "closeRun":
        return {
          records: [
            ...terminalToolCancellationRecords(run.snapshot, "Run closed"),
            ...terminalEffectCancellationRecords(run.snapshot, "Run closed"),
            { eventType: "run.closed", payload: toJsonValue(payload) as Record<string, JsonValue>, visibility: "localSensitive" },
          ],
          result: { status: "accepted" },
        };
      case "cancelRun":
        return {
          records: [
            ...terminalToolCancellationRecords(run.snapshot, "Run cancelled"),
            ...terminalEffectCancellationRecords(run.snapshot, "Run cancelled"),
            { eventType: "run.cancelled", payload: toJsonValue(payload) as Record<string, JsonValue>, visibility: "localSensitive" },
          ],
          result: { status: "cancelled" },
        };
      case "userMessageSubmitted":
        return messageRecord("message.userSubmitted", payload, run.snapshot);
      case "assistantMessageObserved":
        return messageRecord("message.assistantObserved", payload, run.snapshot);
      case "assistantMessageCompleted":
        return messageRecord("message.assistantCompleted", payload, run.snapshot);
      case "toolRequested":
        return toolRequestedRecords(payload, command, run.snapshot, this.options.effectPlanner);
      case "toolExecutionObserved":
        return toolExecutionObservedRecords(payload, run.snapshot);
      case "extensionCommand":
        return extensionCommandRecords(
          command as ScenarioCommand & { payload: typeof payload },
          run,
          this.options.extensionHandler,
          this.options.stateSlicePolicy,
        );
      case "toolDecisionSubmitted":
        return toolDecisionRecords(payload, run.snapshot);
      case "toolExecutionStarted":
        return toolLifecycleRecord("tool.executionStarted", payload, run.snapshot);
      case "toolOutputAppended":
        return toolLifecycleRecord("tool.outputAppended", payload, run.snapshot);
      case "toolCompleted":
        return toolLifecycleRecord("tool.completed", payload, run.snapshot);
      case "toolFailed":
        return toolLifecycleRecord("tool.failed", payload, run.snapshot);
      case "toolCancelled":
        return toolCancellationRecords(payload, run.snapshot);
      case "stateSliceChanged": {
        const slice = stateSliceFromChange(
          run.snapshot,
          command,
          payload,
          this.options.stateSlicePolicy,
        );
        return {
          records: [stateSliceChangedRecord(slice)],
          result: { status: "accepted" },
        };
      }
      case "submitFeedback": {
        const prior = priorFeedbackForIdempotencyKey(run, payload);
        if (prior) {
          assertIdempotentFeedbackMatches(prior, payload);
          return {
            records: [],
            result: { status: "accepted", data: { feedbackId: prior.feedbackId } },
          };
        }
        const entry = this.feedbackEntry(command, run.snapshot, payload);
        return {
          records: [{
            eventType: "feedback.changed",
            entityRef: { kind: payload.targetKind, id: payload.targetId },
            payload: { feedback: toJsonValue(entry) },
            visibility: "localSensitive",
          }],
          result: { status: "accepted", data: { feedbackId: entry.feedbackId } },
          feedback: entry,
        };
      }
      case "requestEffect":
        if (run.snapshot.effects.some((effect) => effect.effectId === payload.effectId)) {
          throw new Error(`Effect already exists: ${payload.effectId}`);
        }
        return {
          records: [{
            eventType: "effect.requested",
            entityRef: { kind: "effect", id: payload.effectId },
            payload: {
              effectId: payload.effectId,
              effectType: payload.effectType ?? "unknown",
              parameters: payload.parameters ?? null,
            },
          }],
          result: { status: "accepted" },
        };
      case "effectStarted":
        if (run.snapshot.effects.find((effect) => effect.effectId === payload.effectId)?.status === "started") {
          assertEffectClaim(run.snapshot, payload.effectId, payload.previousClaimId);
          assertEffectClaimExpired(
            run.snapshot,
            payload.effectId,
            this.clock().getTime(),
            this.options.effectClaimLeaseMs ?? 30_000,
          );
          if (payload.claimId === payload.previousClaimId) {
            throw new Error(`Effect reclaim must use a new claim: ${payload.effectId}`);
          }
        } else {
          assertEffectState(run.snapshot, payload.effectId, ["requested"]);
          if (payload.previousClaimId !== undefined) {
            throw new Error(`New effect claim cannot name a previous claim: ${payload.effectId}`);
          }
        }
        return simple("effect.started", payload, { status: "accepted" });
      case "effectClaimRenewed":
        assertEffectState(run.snapshot, payload.effectId, ["started"]);
        assertEffectClaim(run.snapshot, payload.effectId, payload.claimId);
        return simple("effect.claimRenewed", payload, { status: "accepted" }, "localSensitive");
      case "effectResultSupplied": {
        assertEffectState(run.snapshot, payload.effectId, ["started"]);
        assertEffectClaim(run.snapshot, payload.effectId, payload.claimId);
        return completedEffectRecords(payload, command, run, this.options.stateSlicePolicy);
      }
      case "effectProgressed":
        assertEffectClaim(run.snapshot, payload.effectId, payload.claimId);
        return effectProgressRecords(payload, run.snapshot);
      case "effectFailed": {
        assertEffectState(run.snapshot, payload.effectId, ["started"]);
        assertEffectClaim(run.snapshot, payload.effectId, payload.claimId);
        return failedEffectRecords(
          payload,
          command,
          run,
          this.options.effectPlanner,
          this.options.stateSlicePolicy,
        );
      }
      case "effectCancelled":
        assertEffectState(run.snapshot, payload.effectId, ["started"]);
        assertEffectClaim(run.snapshot, payload.effectId, payload.claimId);
        return simple("effect.cancelled", {
          effectId: payload.effectId,
          reason: payload.reason ?? "Effect cancelled",
        }, { status: "cancelled", reason: payload.reason ?? "Effect cancelled" }, "localSensitive");
      case "providerStateObserved":
        return simple("provider.stateObserved", { state: payload.data ?? {} }, { status: "accepted" }, "localSensitive");
      case "planStateChanged":
        return simple("plan.stateChanged", { state: payload.data ?? {} }, { status: "accepted" }, "localSensitive");
      case "continuationStateChanged":
        return simple("continuation.stateChanged", { state: payload.data ?? {} }, { status: "accepted" }, "localSensitive");
      case "nativeTranscriptObserved":
        return nativeTranscriptRecords(payload.data, run.snapshot, command.recordedAt);
      case "runtimeErrorObserved": {
        const error = normalizeRuntimeError(payload.data);
        const fatal = error.recoverable !== true;
        return {
          records: [
            ...(fatal ? terminalToolCancellationRecords(run.snapshot, "Run failed") : []),
            ...(fatal ? terminalEffectCancellationRecords(run.snapshot, "Run failed") : []),
            ...simple(
              "runtime.error",
              error,
              { status: "failed" },
              "localSensitive",
            ).records,
          ],
          result: { status: "failed" },
        };
      }
    }
  }

  private async executeEffect(request: ScenarioEffectRequest): Promise<ScenarioEffectResult> {
    if (this.options.effectExecutor) return this.options.effectExecutor.execute(request);
    throw new Error(`Unsupported scenario effect: ${request.effectType}`);
  }

  private async reportEffectProgress(
    origin: EffectOrigin,
    effectId: string,
    claimId: string,
    progress: JsonValue,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    const snapshot = await this.snapshot(origin.runId);
    const effect = snapshot.effects.find((candidate) => candidate.effectId === effectId);
    if (
      snapshot.status !== "running" ||
      effect?.status !== "started" ||
      effect.claimId !== claimId ||
      signal.aborted
    ) return;
    try {
      await this.commitInternalCommand(this.effectLifecycleCommand(origin, {
        type: "effectProgressed",
        effectId,
        claimId,
        progress,
      }));
    } catch (error) {
      const current = await this.snapshot(origin.runId);
      const currentEffect = current.effects.find((candidate) => candidate.effectId === effectId);
      if (signal.aborted || current.status !== "running" || currentEffect?.claimId !== claimId) return;
      throw error;
    }
  }

  private feedbackEntry(
    command: ScenarioCommand,
    snapshot: ScenarioSnapshot,
    payload: Extract<ScenarioCommandPayload, { type: "submitFeedback" }>,
  ): FeedbackEntry {
    if (!snapshot.capabilities.feedbackSubmission) throw new Error("Run does not allow feedback submission");
    if (payload.expectedTargetDigest === undefined && payload.targetRecordSeq === undefined) {
      throw new Error("Feedback requires a stable target digest or record sequence");
    }
    const target = payload.targetKind === "assistantMessage"
      ? snapshot.conversation.find((message) => message.id === payload.targetId && message.role === "assistant")
      : snapshot.toolCalls.find((tool) => tool.id === payload.targetId);
    if (!target) throw new FeedbackTargetConflictError(`Feedback target does not exist: ${payload.targetId}`);
    if (payload.targetKind === "assistantMessage" && "status" in target && target.status !== "completed") {
      throw new Error("Assistant feedback target is not stable");
    }
    if ("feedbackDigest" in target && !isTerminalToolStatus(target.status)) {
      throw new Error("Tool feedback target is not terminal");
    }
    const digest = "contentDigest" in target ? target.contentDigest : target.feedbackDigest;
    if (payload.expectedTargetDigest && payload.expectedTargetDigest !== digest) {
      throw new FeedbackTargetConflictError("Feedback target digest is stale");
    }
    if (payload.targetRecordSeq && payload.targetRecordSeq !== target.recordSeq) {
      throw new FeedbackTargetConflictError("Feedback target record sequence is stale");
    }
    const key = `${payload.author.subjectId}:${payload.targetKind}:${payload.targetId}`;
    const previous = snapshot.feedback[key];
    const entry: FeedbackEntry = {
      feedbackId: this.idFactory(),
      runId: command.runId,
      target: {
        kind: payload.targetKind,
        id: payload.targetId,
        recordSeq: target.recordSeq,
        digest,
      },
      vote: payload.vote,
      ...(validateFeedbackNote(payload.note) === undefined ? {} : { note: validateFeedbackNote(payload.note) }),
      createdAt: command.recordedAt,
      author: payload.author,
      supersedesFeedbackId: previous?.feedbackId ?? null,
      idempotencyKey: payload.idempotencyKey,
    };
    return feedbackEntrySchema.parse(entry);
  }

  private record(
    command: ScenarioCommand,
    recordSeq: number,
    eventType: ScenarioEventType,
    payload: Record<string, JsonValue>,
    entityRef?: { kind: string; id: string },
    visibility: ScenarioRecord["visibility"] = "public",
  ): ScenarioRecord {
    return {
      runId: command.runId,
      recordSeq,
      recordId: this.idFactory(),
      recordedAt: command.recordedAt,
      commandId: command.commandId,
      ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
      ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
      eventType,
      ...(entityRef === undefined ? {} : { entityRef }),
      visibility,
      payload: this.protectRecordPayload(
        command.runId,
        command.commandId,
        eventType,
        sanitizeScenarioValueForPersistence(payload, [], { secretPaths: this.options.redactionPaths }),
      ) as Record<string, JsonValue>,
    };
  }

  private async captureLargeValues(command: ScenarioCommand): Promise<CapturedLargeValues> {
    const store = new ArtifactStore(runArtifactsDir(command.runId, this.options.root));
    const threshold = Math.max(1, this.options.maximumInlineBytes ?? 64 * 1024);
    const persistentPayload = redactScenarioValue(
      toJsonValue(command.payload),
      undefined,
      [],
      { secretPaths: this.options.redactionPaths },
    );
    const found = collectLargeValues(persistentPayload, threshold);
    const captured: CapturedLargeValues = { references: new Map(), created: [], store };
    try {
      for (const [digest, value] of found) {
        const serialized = canonicalJson(value);
        const stored = await store.putTracked({
          bytes: Buffer.from(serialized, "utf8"),
          mediaType: "application/json",
          visibility: "localSensitive",
        });
        if (stored.reference.digest !== digest) {
          throw new Error(`Artifact digest mismatch while storing ${digest}`);
        }
        captured.references.set(digest, stored.reference);
        if (stored.created) captured.created.push(stored.reference);
      }
      return captured;
    } catch (error) {
      await this.removeCreatedArtifacts(captured);
      throw error;
    }
  }

  private async removeCreatedArtifacts(captured: CapturedLargeValues): Promise<void> {
    await Promise.all(captured.created.map((artifact) => captured.store.remove(artifact)));
  }

  private protectRecordPayload(
    runId: string,
    commandId: string,
    eventType: string,
    value: JsonValue,
  ): JsonValue {
    const artifacts = this.largeValues.get(commandArtifactScope(runId, commandId));
    return replaceLargeValues(value, artifacts ?? new Map(), commandId, eventType, []);
  }
}

function immutablePublication<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function commandArtifactScope(runId: string, commandId: string): string {
  return canonicalJson([runId, commandId]);
}

const REDUCER_STRUCTURAL_KEYS = new Set([
  "artifact",
  "capabilities",
  "claimId",
  "diagnostics",
  "evaluation",
  "effectId",
  "effectType",
  "feedback",
  "result",
  "rules",
  "slice",
  "state",
  "contentDigest",
  "inputDigest",
  "previousClaimId",
]);

function collectLargeValues(
  value: JsonValue,
  threshold: number,
  found = new Map<string, JsonValue>(),
  depth = 0,
  key?: string,
): Map<string, JsonValue> {
  if (depth > 0 && REDUCER_STRUCTURAL_KEYS.has(key ?? "")) return found;
  const serialized = JSON.stringify(value);
  const isLarge = Buffer.byteLength(serialized, "utf8") >= threshold;
  const canReplace = depth > 0;
  if (isLarge && canReplace && (typeof value === "string" || typeof value === "object" && value !== null)) {
    found.set(digestScenarioValue(value), value);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLargeValues(item, threshold, found, depth + 1, String(index)));
  } else if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) {
      collectLargeValues(child, threshold, found, depth + 1, childKey);
    }
  }
  return found;
}

function replaceLargeValues(
  value: JsonValue,
  artifacts: ReadonlyMap<string, ArtifactRef>,
  commandId: string,
  eventType: string,
  path: string[],
  key?: string,
): JsonValue {
  const depth = path.length;
  if (depth > 0 && REDUCER_STRUCTURAL_KEYS.has(key ?? "")) return escapeReservedArtifactValues(value);
  const artifact = artifacts.get(digestScenarioValue(value));
  const canReplace = depth > 0;
  if (artifact && canReplace) {
    const reference: ArtifactValueReference = {
      $scenarioArtifactValue: {
        version: 1,
        commandId,
        eventType,
        path,
        artifact,
      },
    };
    return typeof value === "string"
      ? artifactStringReference(reference, artifact.preview ?? value.slice(0, 512))
      : reference;
  }
  if (isReservedArtifactValue(value)) {
    return escapeArtifactLiteralValue(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      replaceLargeValues(item, artifacts, commandId, eventType, [...path, String(index)], String(index))
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        replaceLargeValues(child, artifacts, commandId, eventType, [...path, childKey], childKey),
      ]),
    );
  }
  return value;
}

function escapeReservedArtifactValues(value: JsonValue): JsonValue {
  if (isReservedArtifactValue(value)) return escapeArtifactLiteralValue(value);
  if (Array.isArray(value)) return value.map(escapeReservedArtifactValues);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, escapeReservedArtifactValues(child)]));
  }
  return value;
}

function simple(
  eventType: ScenarioEventType,
  payload: unknown,
  result: ScenarioTerminalResult,
  visibility?: ScenarioRecord["visibility"],
): { records: SemanticRecord[]; result: ScenarioTerminalResult } {
  return {
    records: [{
      eventType,
      payload: toJsonValue(payload) as Record<string, JsonValue>,
      ...(visibility === undefined ? {} : { visibility }),
    }],
    result,
  };
}

function messageRecord(
  eventType: "message.userSubmitted" | "message.assistantObserved" | "message.assistantCompleted",
  payload: Extract<ScenarioCommandPayload, { type: "userMessageSubmitted" | "assistantMessageObserved" | "assistantMessageCompleted" }>,
  snapshot: ScenarioSnapshot,
): ReturnType<typeof simple> {
  const existing = snapshot.conversation.find((message) => message.id === payload.messageId);
  if (eventType === "message.userSubmitted") {
    if (existing) throw new Error(`Message ID is already committed: ${payload.messageId}`);
  } else if (existing) {
    if (existing.role !== "assistant" || existing.turnId !== payload.turnId) {
      throw new Error(`Message identity changed: ${payload.messageId}`);
    }
    if (existing.status !== "streaming") {
      throw new Error(`Message is already terminal: ${payload.messageId}`);
    }
  }
  return simple(eventType, payload, { status: "accepted" });
}

function toolLifecycleRecord(
  eventType: "tool.executionStarted" | "tool.outputAppended" | "tool.completed" | "tool.failed" | "tool.cancelled",
  payload: Extract<ScenarioCommandPayload, { type: "toolExecutionStarted" | "toolOutputAppended" | "toolCompleted" | "toolFailed" | "toolCancelled" }>,
  snapshot: ScenarioSnapshot,
): ReturnType<typeof simple> {
  const tool = snapshot.toolCalls.find((candidate) => candidate.id === payload.toolCallId);
  if (!tool) throw new Error(`Unknown tool call: ${payload.toolCallId}`);
  if (isTerminalToolStatus(tool.status)) throw new Error(`Tool call is already terminal: ${payload.toolCallId}`);
  if (eventType === "tool.executionStarted") {
    if (tool.status !== "requested" && tool.status !== "waiting") {
      throw new Error(`toolExecutionStarted is not allowed while tool status is ${tool.status}`);
    }
  } else if (tool.status !== "running") {
    throw new Error(`${payload.type} requires a running tool call; current status is ${tool.status}`);
  }
  return simple(eventType, payload, { status: eventType === "tool.failed" ? "failed" : "accepted" });
}

function toolCancellationRecords(
  payload: Extract<ScenarioCommandPayload, {
    type: "toolExecutionStarted" | "toolOutputAppended" | "toolCompleted" | "toolFailed" | "toolCancelled";
  }>,
  snapshot: ScenarioSnapshot,
): SemanticResult {
  const tool = snapshot.toolCalls.find((candidate) => candidate.id === payload.toolCallId);
  if (!tool) throw new Error(`Unknown tool call: ${payload.toolCallId}`);
  if (isTerminalToolStatus(tool.status)) {
    throw new Error(`Tool call is already terminal: ${payload.toolCallId}`);
  }
  const reason = payload.error ?? "Tool cancelled";
  return {
    records: toolCancellationSemanticRecords(tool, reason),
    result: { status: "cancelled", reason },
  };
}

function terminalToolCancellationRecords(snapshot: ScenarioSnapshot, reason: string): SemanticRecord[] {
  return snapshot.toolCalls
    .filter((tool) => !isTerminalToolStatus(tool.status))
    .flatMap((tool) => toolCancellationSemanticRecords(tool, reason));
}

function terminalEffectCancellationRecords(snapshot: ScenarioSnapshot, reason: string): SemanticRecord[] {
  return snapshot.effects
    .filter((effect) => isPendingEffectStatus(effect.status))
    .map((effect): SemanticRecord => ({
      eventType: "effect.cancelled",
      entityRef: { kind: "effect", id: effect.effectId },
      payload: { effectId: effect.effectId, reason },
      visibility: "localSensitive",
    }));
}

function toolCancellationSemanticRecords(
  tool: ScenarioSnapshot["toolCalls"][number],
  reason: string,
): SemanticRecord[] {
  const entityRef = { kind: "toolCall", id: tool.id };
  return [
    {
      eventType: "tool.authorization.finalResolved",
      entityRef,
      visibility: "localSensitive",
      payload: { toolCallId: tool.id, final: "cancelled", reason },
    },
    {
      eventType: "tool.cancelled",
      entityRef,
      visibility: "localSensitive",
      payload: { toolCallId: tool.id, error: reason },
    },
  ];
}

function toolRequestedRecords(
  payload: Extract<ScenarioCommandPayload, { type: "toolRequested" }>,
  command: ScenarioCommand,
  snapshot: ScenarioSnapshot,
  effectPlanner: ScenarioEffectPlanner | undefined,
): SemanticResult {
  if (snapshot.toolCalls.some((tool) => tool.id === payload.toolCallId)) {
    throw new Error(`Tool call already exists: ${payload.toolCallId}`);
  }
  const effect = plannedEffect(command, snapshot, effectPlanner);
  const persistedParameters = redactScenarioValue(effect.parameters);
  return {
    records: [
      {
        eventType: "effect.requested",
        payload: {
          effectId: effect.effectId,
          effectType: effect.effectType,
          parameters: persistedParameters,
        },
        entityRef: { kind: "effect", id: effect.effectId },
        visibility: "localSensitive",
      },
      canonicalToolRequestedRecord(payload),
    ],
    result: { status: "accepted" },
  };
}

function plannedEffect(
  command: ScenarioCommand,
  snapshot: ScenarioSnapshot,
  planner: ScenarioEffectPlanner | undefined,
): PlannedScenarioEffect {
  const effect = planner?.plan(command, snapshot);
  if (!effect) throw new Error(`Scenario effect planner is unavailable for ${command.payload.type}`);
  return effect;
}

function toolExecutionObservedRecords(
  payload: Extract<ScenarioCommandPayload, { type: "toolExecutionObserved" }>,
  snapshot: ScenarioSnapshot,
): SemanticResult {
  if (snapshot.toolCalls.some((tool) => tool.id === payload.toolCallId)) {
    throw new Error(`Tool call already exists: ${payload.toolCallId}`);
  }
  const reason = "Provider runtime began this tool before emitting an observation; canonical pre-execution policy was not enforced";
  return {
    records: observedToolLifecycleRecords({
      tool: {
        toolCallId: payload.toolCallId,
        turnId: payload.turnId,
        name: payload.name,
        input: payload.input,
        inputDigest: payload.inputDigest,
      },
      authorization: {
        policy: "notEnforced",
        final: "observed",
        policyReason: reason,
        finalReason: reason,
      },
      target: { status: "running" },
    }),
    result: { status: "accepted" },
  };
}

function extensionCommandRecords(
  command: ScenarioCommand & {
    payload: Extract<ScenarioCommandPayload, { type: "extensionCommand" }>;
  },
  run: OpenRun,
  handler: ScenarioCommandExtensionHandler | undefined,
  stateSlicePolicy: ScenarioStateSlicePolicy | undefined,
): SemanticResult {
  const result = handler?.project(command, run.snapshot);
  if (!result) throw new Error(`Scenario command extension is unavailable: ${command.payload.extensionId}`);
  const records = projectedMutationRecords(result.mutations, command, run, stateSlicePolicy);
  return { records, result: scenarioTerminalResultSchema.parse(result.terminalResult) };
}

function projectedMutationRecords(
  mutations: readonly ScenarioCommandExtensionMutation[],
  command: ScenarioCommand,
  run: OpenRun,
  stateSlicePolicy: ScenarioStateSlicePolicy | undefined,
): SemanticRecord[] {
  const records: SemanticRecord[] = [];
  const projectedSnapshot = structuredClone(run.snapshot);
  for (const mutation of mutations) {
    if (mutation.kind === "stateChange") {
      const change = scenarioEffectStateChangeSchema.parse(mutation.change);
      const slice = stateSliceFromChange(projectedSnapshot, command, change, stateSlicePolicy);
      projectedSnapshot.stateSlices[slice.key] = slice;
      records.push(stateSliceChangedRecord(slice));
      continue;
    }
    const projected = scenarioEffectProjectionRecordSchema.parse(mutation.record);
    if (projected.dedupeByEventAndEntity && (
      run.records.some((record) => sameEventAndEntity(record, projected)) ||
      records.some((record) => sameEventAndEntity(record, projected))
    )) continue;
    records.push({
      eventType: projected.eventType,
      payload: projected.payload,
      ...(projected.entityRef === undefined ? {} : { entityRef: projected.entityRef }),
      ...(projected.visibility === undefined ? {} : { visibility: projected.visibility }),
    });
  }
  return records;
}

function sameEventAndEntity(
  left: Pick<SemanticRecord, "eventType" | "entityRef">,
  right: Pick<SemanticRecord, "eventType" | "entityRef">,
): boolean {
  return left.eventType === right.eventType &&
    left.entityRef?.kind === right.entityRef?.kind &&
    left.entityRef?.id === right.entityRef?.id;
}

function stateSliceFromChange(
  snapshot: ScenarioSnapshot,
  command: ScenarioCommand,
  change: {
    key: string;
    schemaId: string;
    status: ScenarioSnapshot["stateSlices"][string]["status"];
    source: string;
    visibility: ScenarioSnapshot["stateSlices"][string]["visibility"];
    value: JsonValue;
    baseValue?: JsonValue;
    diagnostics: string[];
  },
  stateSlicePolicy?: ScenarioStateSlicePolicy,
): ScenarioSnapshot["stateSlices"][string] {
  const resolved = change.baseValue !== undefined
    ? stateSlicePolicy?.merge?.({
        key: change.key,
        baseValue: change.baseValue,
        incomingValue: change.value,
        currentValue: snapshot.stateSlices[change.key]?.value,
      }) ?? change.value
    : change.value;
  return {
    key: change.key,
    schemaId: change.schemaId,
    revision: (snapshot.stateSlices[change.key]?.revision ?? 0) + 1,
    status: change.status,
    source: change.source,
    updatedAt: command.recordedAt,
    visibility: change.visibility,
    value: stateSlicePolicy?.normalize?.(change.key, resolved) ?? resolved,
    diagnostics: change.diagnostics,
  };
}

function stateSliceChangedRecord(
  slice: ScenarioSnapshot["stateSlices"][string],
): SemanticRecord {
  return {
    eventType: "state.sliceChanged",
    entityRef: { kind: "stateSlice", id: slice.key },
    visibility: slice.visibility,
    payload: { slice: toJsonValue(slice) },
  };
}

function toolDecisionRecords(
  payload: Extract<ScenarioCommandPayload, { type: "toolDecisionSubmitted" }>,
  snapshot: ScenarioSnapshot,
): SemanticResult {
  const tool = snapshot.toolCalls.find((item) => item.id === payload.toolCallId);
  if (!tool) throw new Error(`Unknown tool call: ${payload.toolCallId}`);
  if (tool.authorization.user !== "pending") throw new Error(`Tool call is not awaiting a decision: ${payload.toolCallId}`);
  const final = payload.decision === "approve" ? "allowed" : "denied";
  const entityRef = { kind: "toolCall", id: payload.toolCallId };
  return {
    records: [
      {
        eventType: "tool.authorization.userDecisionSubmitted",
        payload: toJsonValue(payload) as Record<string, JsonValue>,
        entityRef,
        visibility: "localSensitive",
      },
      {
        eventType: "tool.authorization.finalResolved",
        payload: { toolCallId: payload.toolCallId, final, reason: payload.reason },
        entityRef,
        visibility: "localSensitive",
      },
    ],
    result: { status: final === "allowed" ? "allowed" : "denied", ...(payload.reason ? { reason: payload.reason } : {}) },
  };
}

function completedEffectRecords(
  payload: Extract<ScenarioCommandPayload, { type: "effectResultSupplied" }>,
  command: ScenarioCommand,
  run: OpenRun,
  stateSlicePolicy: ScenarioStateSlicePolicy | undefined,
): SemanticResult {
  return projectedEffectRecords({
    baseRecord: {
      eventType: "effect.completed",
      entityRef: { kind: "effect", id: payload.effectId },
      visibility: "localSensitive",
      payload: {
        effectId: payload.effectId,
        result: payload.result ?? null,
        metadata: toJsonValue(payload.metadata ?? {}),
      },
    },
    projection: payload.projection,
    defaultTerminal: { status: "accepted" },
    command,
    run,
    stateSlicePolicy,
  });
}

function effectProgressRecords(
  payload: Extract<ScenarioCommandPayload, { type: "effectProgressed" }>,
  snapshot: ScenarioSnapshot,
): SemanticResult {
  const effect = snapshot.effects.find((candidate) => candidate.effectId === payload.effectId);
  if (!effect) throw new Error(`Unknown effect: ${payload.effectId}`);
  assertEffectState(snapshot, payload.effectId, ["started"]);

  return {
    records: [{
      eventType: "effect.progressed",
      entityRef: { kind: "effect", id: payload.effectId },
      visibility: "localSensitive",
      payload: { effectId: payload.effectId, progress: payload.progress },
    }],
    result: { status: "accepted" },
  };
}

function failedEffectRecords(
  payload: Extract<ScenarioCommandPayload, { type: "effectFailed" }>,
  command: ScenarioCommand,
  run: OpenRun,
  planner: ScenarioEffectPlanner | undefined,
  stateSlicePolicy: ScenarioStateSlicePolicy | undefined,
): SemanticResult {
  const effect = run.snapshot.effects.find((candidate) => candidate.effectId === payload.effectId);
  if (!effect) throw new Error(`Unknown effect: ${payload.effectId}`);
  const projection = planner?.projectFailure({
    effectId: effect.effectId,
    effectType: effect.effectType,
    parameters: effect.parameters,
  }, payload.error, run.snapshot) ?? undefined;
  return projectedEffectRecords({
    baseRecord: {
      eventType: "effect.failed",
      entityRef: { kind: "effect", id: payload.effectId },
      visibility: "localSensitive",
      payload: { effectId: payload.effectId, error: payload.error },
    },
    projection,
    defaultTerminal: { status: "failed", reason: payload.error },
    command,
    run,
    stateSlicePolicy,
  });
}

function projectedEffectRecords(input: {
  baseRecord: SemanticRecord;
  projection: ScenarioEffectProjection | undefined;
  defaultTerminal: ScenarioTerminalResult;
  command: ScenarioCommand;
  run: OpenRun;
  stateSlicePolicy: ScenarioStateSlicePolicy | undefined;
}): SemanticResult {
  const terminal = input.projection === undefined
    ? input.defaultTerminal
    : scenarioTerminalResultSchema.parse(input.projection.terminalResult);
  const projectionMutations: ScenarioCommandExtensionMutation[] = [
    ...(input.projection?.records ?? []).map((record) => ({ kind: "record" as const, record })),
    ...(input.projection?.stateChanges ?? []).map((change) => ({ kind: "stateChange" as const, change })),
  ];
  const records: SemanticRecord[] = [
    input.baseRecord,
    ...projectedMutationRecords(
      projectionMutations,
      input.command,
      input.run,
      input.stateSlicePolicy,
    ),
  ];
  if (input.command.causationId) {
    records.push({
      eventType: "command.completed",
      visibility: "localSensitive",
      payload: { commandId: input.command.causationId, result: toJsonValue(terminal) },
    });
  }
  return { records, result: terminal };
}

function nativeTranscriptRecords(
  data: NativeTranscriptData | undefined,
  snapshot: ScenarioSnapshot,
  recordedAt: string,
): SemanticResult {
  const imported = data ?? { messages: [], tools: [] };
  const priorActive = nativeTranscriptActiveIds(snapshot);
  for (const message of imported.messages) {
    if (message.contentDigest !== digestScenarioValue(message.content)) {
      throw new Error(`Native transcript message digest mismatch: ${message.id}`);
    }
    const existing = snapshot.conversation.find((candidate) => candidate.id === message.id);
    if (!existing) continue;
    if (existing.role !== message.role || existing.turnId !== message.turnId) {
      throw new Error(`Native transcript message identity changed: ${message.id}`);
    }
    if (existing.role === "user" && (
      existing.contentDigest !== message.contentDigest || existing.status !== message.status
    )) {
      throw new Error(`Native transcript user message changed: ${message.id}`);
    }
    if (isTerminalMessageStatus(existing.status) && (
      existing.contentDigest !== message.contentDigest || existing.status !== message.status
    )) {
      throw new Error(`Native transcript terminal message changed: ${message.id}`);
    }
  }
  const reconciledTools = reconcileNativeTranscriptTools(imported.tools, snapshot, priorActive);
  for (const { tool, existing } of reconciledTools) {
    if (!existing) continue;
    const terminalHostTool = existing.turnId === null && isTerminalToolStatus(existing.status);
    if (
      existing.name !== tool.name ||
      (!terminalHostTool && existing.turnId !== tool.turnId) ||
      existing.inputDigest !== tool.inputDigest
    ) {
      throw new Error(`Native transcript tool identity changed: ${tool.id}`);
    }
    const outputIsOrderedPrefix = terminalHostTool || existing.output.length <= tool.output.length &&
      existing.output.every((output, index) => canonicalJsonEqual(output, tool.output[index]));
    if (!outputIsOrderedPrefix) {
      throw new Error(`Native transcript tool output changed: ${tool.id}`);
    }
    if (isTerminalToolStatus(existing.status) && !terminalHostTool && (
      existing.status !== tool.status ||
      existing.output.length !== tool.output.length ||
      existing.error !== tool.error
    )) {
      throw new Error(`Native transcript terminal tool changed: ${tool.id}`);
    }
  }
  const records: SemanticRecord[] = [{
    eventType: "transcript.observed",
    visibility: "localSensitive",
    payload: { messageCount: imported.messages.length, toolCount: imported.tools.length },
  }];
  const activeMessageIds = new Set<string>();
  const claimedExistingMessageIds = new Set<string>();
  const messageRecords: SemanticRecord[] = [];
  for (const message of imported.messages) {
    const existingById = snapshot.conversation.find((existing) => existing.id === message.id);
    if (existingById) {
      activeMessageIds.add(existingById.id);
      claimedExistingMessageIds.add(existingById.id);
    }
    if (existingById &&
      existingById.contentDigest === message.contentDigest &&
      existingById.status === message.status
    ) continue;
    const matchingHostMessage = existingById ? undefined : snapshot.conversation.find((existing) =>
      !priorActive.messageIds.has(existing.id) &&
      !claimedExistingMessageIds.has(existing.id) &&
      existing.role === message.role &&
      existing.contentDigest === message.contentDigest &&
      existing.status === message.status &&
      (existing.turnId === message.turnId || message.role === "user")
    );
    if (matchingHostMessage) {
      activeMessageIds.add(message.id);
      claimedExistingMessageIds.add(matchingHostMessage.id);
      messageRecords.push({
        eventType: "message.retired",
        entityRef: { kind: "message", id: matchingHostMessage.id },
        visibility: "localSensitive",
        payload: {
          messageId: matchingHostMessage.id,
          reason: "nativeTranscriptIdentityReconciled",
        },
      });
    } else {
      activeMessageIds.add(message.id);
    }
    messageRecords.push({
      eventType: "message.observed",
      entityRef: { kind: "message", id: message.id },
      visibility: "localSensitive",
      payload: {
        messageId: message.id,
        turnId: message.turnId,
        role: message.role,
        content: message.content,
        contentDigest: message.contentDigest,
        status: message.status,
        ...(message.usage === undefined ? {} : { usage: message.usage }),
      },
    });
  }
  for (const messageId of priorActive.messageIds) {
    if (activeMessageIds.has(messageId)) continue;
    if (!snapshot.conversation.some((message) => message.id === messageId)) continue;
    records.push({
      eventType: "message.retired",
      entityRef: { kind: "message", id: messageId },
      visibility: "localSensitive",
      payload: { messageId, reason: "nativeTranscriptReplacement" },
    });
  }
  records.push(...messageRecords);

  const activeToolCallIds = new Set(reconciledTools.map(({ canonicalToolCallId }) => canonicalToolCallId));
  for (const toolCallId of priorActive.toolCallIds) {
    if (activeToolCallIds.has(toolCallId)) continue;
    if (!snapshot.toolCalls.some((toolCall) => toolCall.id === toolCallId)) continue;
    records.push({
      eventType: "tool.retired",
      entityRef: { kind: "toolCall", id: toolCallId },
      visibility: "localSensitive",
      payload: { toolCallId, reason: "nativeTranscriptReplacement" },
    });
  }
  for (const { tool, canonicalToolCallId, existing } of reconciledTools) {
    if (existing && isTerminalToolStatus(existing.status)) continue;
    records.push(...observedToolLifecycleRecords({
      tool: {
        toolCallId: canonicalToolCallId,
        turnId: tool.turnId,
        name: tool.name,
        input: tool.input,
        inputDigest: tool.inputDigest,
      },
      existing,
      authorization: nativeTranscriptToolAuthorization(tool),
      target: {
        status: tool.status,
        appendedOutput: tool.output,
        error: tool.error,
      },
    }));
  }
  records.push(stateSliceChangedRecord({
    key: "transcript.native",
    schemaId: "scenario://state/native-transcript",
    revision: (snapshot.stateSlices["transcript.native"]?.revision ?? 0) + 1,
    status: "validated",
    source: "nativeTranscript",
    updatedAt: recordedAt,
    visibility: "localSensitive",
    value: {
      digest: imported.digest ?? digestScenarioValue({ messages: imported.messages, tools: imported.tools }),
      messageIds: [...activeMessageIds],
      toolCallIds: [...activeToolCallIds],
      toolAliases: Object.fromEntries(reconciledTools.map(({ tool, canonicalToolCallId }) =>
        [tool.id, canonicalToolCallId]
      )),
    },
    diagnostics: [],
  }));
  return { records, result: { status: "accepted" } };
}

function nativeTranscriptActiveIds(snapshot: ScenarioSnapshot): {
  messageIds: Set<string>;
  toolCallIds: Set<string>;
  toolAliases: Map<string, string>;
} {
  const value = snapshot.stateSlices["transcript.native"]?.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { messageIds: new Set(), toolCallIds: new Set(), toolAliases: new Map() };
  }
  const messageIds = Array.isArray(value.messageIds)
    ? value.messageIds.filter((id): id is string => typeof id === "string")
    : [];
  const toolCallIds = Array.isArray(value.toolCallIds)
    ? value.toolCallIds.filter((id): id is string => typeof id === "string")
    : [];
  const toolAliases = typeof value.toolAliases === "object" &&
      value.toolAliases !== null &&
      !Array.isArray(value.toolAliases)
    ? Object.entries(value.toolAliases).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      )
    : [];
  return {
    messageIds: new Set(messageIds),
    toolCallIds: new Set(toolCallIds),
    toolAliases: new Map(toolAliases),
  };
}

type NativeTranscriptTool = NativeTranscriptData["tools"][number];

type ReconciledNativeTranscriptTool = {
  tool: NativeTranscriptTool;
  canonicalToolCallId: string;
  existing: ScenarioSnapshot["toolCalls"][number] | undefined;
};

function reconcileNativeTranscriptTools(
  tools: readonly NativeTranscriptTool[],
  snapshot: ScenarioSnapshot,
  priorActive: ReturnType<typeof nativeTranscriptActiveIds>,
): ReconciledNativeTranscriptTool[] {
  const claimedCanonicalIds = new Set<string>();
  return tools.map((tool) => {
    if (tool.inputDigest !== digestScenarioValue(tool.input)) {
      throw new Error(`Native transcript tool digest mismatch: ${tool.id}`);
    }
    const exact = snapshot.toolCalls.find((candidate) => candidate.id === tool.id);
    const priorAliasId = priorActive.toolAliases.get(tool.id);
    const aliased = priorAliasId === undefined
      ? undefined
      : snapshot.toolCalls.find((candidate) => candidate.id === priorAliasId);
    if (priorAliasId !== undefined && !aliased) {
      throw new Error(`Native transcript tool alias target is missing: ${tool.id}`);
    }
    if (exact && aliased && exact.id !== aliased.id) {
      throw new Error(`Native transcript tool alias conflicts with canonical ID: ${tool.id}`);
    }
    const hostMatches = exact || aliased ? [] : snapshot.toolCalls.filter((candidate) =>
      candidate.turnId === null &&
      isTerminalToolStatus(candidate.status) &&
      candidate.name === tool.name &&
      candidate.inputDigest === tool.inputDigest &&
      !priorActive.toolCallIds.has(candidate.id) &&
      !claimedCanonicalIds.has(candidate.id)
    );
    if (hostMatches.length > 1) {
      throw new Error(`Native transcript tool identity is ambiguous: ${tool.id}`);
    }
    const existing = exact ?? aliased ?? hostMatches[0];
    const canonicalToolCallId = existing?.id ?? tool.id;
    if (claimedCanonicalIds.has(canonicalToolCallId)) {
      throw new Error(`Native transcript tool identity is duplicated: ${tool.id}`);
    }
    claimedCanonicalIds.add(canonicalToolCallId);
    return { tool, canonicalToolCallId, existing };
  });
}

function nativeTranscriptToolAuthorization(tool: NativeTranscriptTool): ObservedToolAuthorization {
  if (tool.status === "waiting") {
    return {
      policy: "allowed",
      final: "denied",
      policyReason: null,
      finalReason: "Pending authorization was recovered fail-closed",
      userUnavailable: "always",
    };
  }
  const denied = tool.status === "denied";
  const requested = tool.status === "requested";
  return {
    policy: denied ? "denied" : requested ? "allowed" : "notEnforced",
    final: denied ? "denied" : requested ? "allowed" : "observed",
    policyReason: denied ? tool.error : null,
    finalReason: denied ? tool.error : null,
    userUnavailable: "ifPending",
  };
}

function commandVisibility(payload: ScenarioCommandPayload): ScenarioRecord["visibility"] {
  if (payload.type === "stateSliceChanged") return payload.visibility;
  if (
    payload.type === "extensionCommand" ||
    payload.type.startsWith("tool") ||
    payload.type.endsWith("MessageSubmitted") ||
    payload.type.startsWith("assistantMessage") ||
    payload.type.startsWith("effect") ||
    payload.type === "requestEffect" ||
    payload.type === "nativeTranscriptObserved" ||
    payload.type === "runtimeErrorObserved" ||
    payload.type === "startRun" ||
    payload.type === "resumeRun" ||
    payload.type === "closeRun" ||
    payload.type === "cancelRun" ||
    payload.type === "providerStateObserved" ||
    payload.type === "planStateChanged" ||
    payload.type === "continuationStateChanged" ||
    payload.type === "submitFeedback"
  ) return "localSensitive";
  return "public";
}

function priorFeedbackForIdempotencyKey(
  run: OpenRun,
  payload: Extract<ScenarioCommandPayload, { type: "submitFeedback" }>,
): FeedbackEntry | undefined {
  for (let index = run.records.length - 1; index >= 0; index -= 1) {
    const record = run.records[index];
    if (record.eventType !== "feedback.changed") continue;
    const parsed = feedbackEntrySchema.safeParse(record.payload.feedback);
    if (!parsed.success) continue;
    if (
      parsed.data.idempotencyKey === payload.idempotencyKey &&
      parsed.data.author.subjectId === payload.author.subjectId
    ) return parsed.data;
  }
  return undefined;
}

function assertIdempotentFeedbackMatches(
  prior: FeedbackEntry,
  payload: Extract<ScenarioCommandPayload, { type: "submitFeedback" }>,
): void {
  if (
    prior.target.kind !== payload.targetKind ||
    prior.target.id !== payload.targetId ||
    prior.vote !== payload.vote ||
    prior.note !== validateFeedbackNote(payload.note)
  ) {
    throw new Error("Feedback idempotency key was reused with different content");
  }
}

function assertEffectState(
  snapshot: ScenarioSnapshot,
  effectId: string,
  allowed: Array<ScenarioSnapshot["effects"][number]["status"]>,
): void {
  const effect = snapshot.effects.find((candidate) => candidate.effectId === effectId);
  if (!effect) throw new Error(`Unknown effect: ${effectId}`);
  if (!allowed.includes(effect.status)) throw new Error(`Effect ${effectId} is already ${effect.status}`);
}

function assertEffectClaim(
  snapshot: ScenarioSnapshot,
  effectId: string,
  claimId: string | undefined,
): void {
  const effect = snapshot.effects.find((candidate) => candidate.effectId === effectId);
  if (!effect) throw new Error(`Unknown effect: ${effectId}`);
  if (!claimId || effect.claimId !== claimId) {
    throw new Error(`Effect claim is stale: ${effectId}`);
  }
}

function isEffectClaimExpired(
  effect: Pick<ScenarioSnapshot["effects"][number], "claimId" | "claimRenewedAt" | "startedAt">,
  now: number,
  leaseMs: number,
): boolean {
  const leaseTimestamp = effect.claimRenewedAt ?? effect.startedAt;
  const renewedAt = leaseTimestamp ? Date.parse(leaseTimestamp) : Number.NaN;
  return Boolean(effect.claimId) && Number.isFinite(renewedAt) && now - renewedAt >= leaseMs;
}

function assertEffectClaimExpired(
  snapshot: ScenarioSnapshot,
  effectId: string,
  now: number,
  leaseMs: number,
): void {
  const effect = snapshot.effects.find((candidate) => candidate.effectId === effectId);
  if (!effect) throw new Error(`Unknown effect: ${effectId}`);
  if (!isEffectClaimExpired(effect, now, leaseMs)) {
    throw new Error(`Effect claim lease is still active: ${effectId}`);
  }
}

function commandIdentityDigest(command: ScenarioCommand): string {
  return digestScenarioValue(toJsonValue({
    commandId: command.commandId,
    runId: command.runId,
    source: command.source,
    ...(command.expectedSnapshotRevision === undefined
      ? {}
      : { expectedSnapshotRevision: command.expectedSnapshotRevision }),
    ...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
    ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
    payload: command.payload,
  }));
}

function assertCommandRetryMatches(command: ScenarioCommand, run: OpenRun): void {
  const accepted = run.records.find((record) =>
    record.commandId === command.commandId && record.eventType === "command.accepted"
  );
  if (accepted?.payload.commandDigest === commandIdentityDigest(command)) return;
  throw new Error(`Command ID collision: ${command.commandId}`);
}

function assertRunLifecycle(payload: ScenarioCommandPayload, snapshot: ScenarioSnapshot): void {
  const status = snapshot.status;
  if (payload.type === "startRun") {
    if (status === "created") return;
    throw new Error(`startRun requires a newly created run; current status is ${status}`);
  }
  if (payload.type === "resumeRun") {
    if (isTerminalRunStatus(status)) return;
    throw new Error(`resumeRun is not allowed while run status is ${status}`);
  }
  if (status === "created") {
    throw new Error(`Run must be started before ${payload.type}`);
  }
  if (isTerminalRunStatus(status) && payload.type !== "submitFeedback") {
    throw new Error(`${payload.type} is not allowed while run status is ${status}`);
  }
}

function assertCommandCapabilities(payload: ScenarioCommandPayload, snapshot: ScenarioSnapshot): void {
  if (payload.type === "userMessageSubmitted" && !snapshot.capabilities.conversationInput) {
    throw new Error("Run does not allow conversation input");
  }
  if (payload.type === "planStateChanged" && !snapshot.capabilities.planControl) {
    throw new Error("Run does not allow plan control");
  }
  if (payload.type === "toolDecisionSubmitted" && !snapshot.capabilities.interactiveToolDecisions) {
    throw new Error("Run does not allow interactive tool decisions");
  }
  if (payload.type === "toolExecutionObserved" && !snapshot.capabilities.toolExecution) {
    throw new Error("Run does not allow tool execution observations");
  }
  if (payload.type === "cancelRun" && !snapshot.capabilities.runCancellation) {
    throw new Error("Run does not allow cancellation");
  }
}

function manifestStatus(
  payload: ScenarioCommandPayload,
  current: RunManifest["status"],
): RunManifest["status"] {
  if (payload.type === "startRun" || payload.type === "resumeRun") return "running";
  if (payload.type === "closeRun") return "closed";
  if (payload.type === "cancelRun") return "cancelled";
  if (payload.type === "runtimeErrorObserved") {
    return normalizeRuntimeError(payload.data).recoverable === true ? current : "failed";
  }
  return current;
}

function shouldUpdateRegistry(payload: ScenarioCommandPayload): boolean {
  return !isScenarioEffectLifecycleCommand(payload) &&
    payload.type !== "toolOutputAppended" &&
    payload.type !== "assistantMessageObserved";
}

function manifestForStartCommand(
  command: ScenarioCommand & { payload: Extract<ScenarioCommandPayload, { type: "startRun" }> },
  redactionPaths?: readonly string[],
): RunManifest;
function manifestForStartCommand(command: ScenarioCommand, redactionPaths?: readonly string[]): RunManifest;
function manifestForStartCommand(command: ScenarioCommand, redactionPaths?: readonly string[]): RunManifest {
  if (command.payload.type !== "startRun") throw new Error("Only startRun can define a manifest");
  assertScenarioSchemaDigest(command);
  const payload = command.payload;
  return runManifestSchema.parse({
    runId: command.runId,
    source: command.source,
    workingDir: payload.workingDir,
    projectDir: payload.projectDir,
    adapter: command.source.adapter ?? null,
    provider: command.source.provider ?? null,
    nativeSessionIds: command.source.nativeSessionId ? [command.source.nativeSessionId] : [],
    engineVersion: payload.engineVersion,
    schemaDigest: payload.schemaDigest,
    capabilities: payload.capabilities,
    storagePolicy: payload.storagePolicy,
    runtimeHome: redactScenarioValue(
      toJsonValue(payload.runtimeHome),
      undefined,
      ["runtimeHome"],
      { secretPaths: redactionPaths },
    ),
    configuration: redactScenarioValue(
      toJsonValue(payload.configuration),
      undefined,
      [],
      { secretPaths: redactionPaths },
    ) as Record<string, JsonValue>,
    createdAt: command.recordedAt,
    updatedAt: command.recordedAt,
    status: "created",
  });
}

function assertScenarioSchemaDigest(command: ScenarioCommand): void {
  if (command.payload.type !== "startRun") return;
  const expected = scenarioProtocolSchemaDigest();
  if (command.payload.schemaDigest !== expected) {
    throw new Error(
      `startRun schemaDigest must equal the current Scenario protocol digest ${expected}`,
    );
  }
}

function equivalentRunStart(
  command: StartRunCommand,
  manifest: RunManifest,
  redactionPaths?: readonly string[],
): boolean {
  const expected = manifestForStartCommand(command, redactionPaths);
  const identity = (candidate: RunManifest) => canonicalJson(toJsonValue({
    source: {
      kind: candidate.source.kind,
      adapter: candidate.source.adapter ?? null,
      provider: candidate.source.provider ?? null,
    },
    adapter: candidate.adapter,
    provider: candidate.provider,
    engineVersion: candidate.engineVersion,
    schemaDigest: candidate.schemaDigest,
    workingDir: candidate.workingDir,
    projectDir: candidate.projectDir,
    capabilities: candidate.capabilities,
    storagePolicy: candidate.storagePolicy,
    runtimeHome: candidate.runtimeHome,
    configuration: candidate.configuration,
  }));
  return identity(expected) === identity(manifest);
}

function normalizeRuntimeError(value: JsonValue | undefined): Record<string, JsonValue> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return runtimeErrorSchema.parse({
      code: typeof value.code === "string" ? value.code : "runtime_error",
      message: typeof value.message === "string" ? value.message : "Runtime error",
      recoverable: value.recoverable === true,
      metadata: typeof value.metadata === "object" && value.metadata !== null && !Array.isArray(value.metadata)
        ? value.metadata
        : {},
    });
  }
  return runtimeErrorSchema.parse({
    code: "runtime_error",
    message: "Runtime error",
    recoverable: false,
    metadata: {},
  });
}
