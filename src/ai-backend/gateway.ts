import { artifactRefSchema, type ArtifactRef } from "../scenario/protocol/artifacts.js";
import { createScenarioCommandEnvelope } from "../scenario/protocol/command-envelope.js";
import { MAXIMUM_ARTIFACT_BYTES } from "../scenario/protocol/limits.js";
import type { ScenarioCommand } from "../scenario/protocol/commands.js";
import type { ToolDecision } from "../scenario/protocol/commands.js";
import type { ScenarioVisibility } from "../scenario/protocol/common.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import {
  scenarioGatewayRequestSchema,
  scenarioGatewayResponseSchema,
  type ScenarioGatewayEvent,
  type ScenarioGatewayErrorCode,
  type ScenarioGatewayRequest,
  type ScenarioGatewayResponse,
  type ProviderResumeTarget,
  type ProviderRunConfig,
  scenarioGatewayOperationScopes,
  scenarioGatewayScopes,
} from "../scenario/protocol/gateway.js";
import { eventBatchSchema, type EventBatch, type ScenarioRecord } from "../scenario/protocol/records.js";
import { scenarioSnapshotSchema, type ScenarioSnapshot } from "../scenario/protocol/snapshot.js";
import type { ScenarioRuntime } from "../scenario/runtime/runtime.js";
import {
  FeedbackTargetConflictError,
  SnapshotRevisionConflictError,
} from "../scenario/runtime/errors.js";
import { errorMessage } from "../utils/output.js";
import { reportBackgroundError } from "../utils/background-errors.js";

export type ScenarioGatewayAuthority = {
  subjectId: string;
  clientId: string;
  clientVersion: string;
  scopes: readonly string[];
  visibilityScope: readonly ScenarioVisibility[];
};

export type ScenarioGatewayOptions = {
  authority?: Partial<ScenarioGatewayAuthority>;
  emit?: (event: ScenarioGatewayEvent) => void;
  maximumArtifactBytes?: number;
  pollIntervalMs?: number;
  providerHost?: ScenarioProviderHost;
  onBackgroundError?: (
    error: unknown,
    context: { operation: ScenarioGatewayRequest["payload"]["operation"]; runId: string | null },
  ) => void;
};

export type ScenarioProviderHost = {
  start(config: ProviderRunConfig): Promise<{ runId: string }>;
  resume(
    runId: string,
    config: ProviderRunConfig,
    target: ProviderResumeTarget,
  ): Promise<{ runId: string }>;
  send(runId: string, turnId: string, input: string): Promise<void>;
  /** Whole-run cancellation resolves only after authorization waiters are terminal and the provider is detached. */
  cancel(runId: string, turnId: string | null): Promise<void>;
  close(runId: string): Promise<void>;
  settleToolDecision?(
    runId: string,
    toolCallId: string,
    decision: ToolDecision,
    reason: string | null,
  ): Promise<"settled" | "providerDetached">;
};

type ActiveSubscription = {
  stop(): void;
};

export class ScenarioGateway {
  private readonly authority: ScenarioGatewayAuthority;
  private readonly activePolls = new Set<Promise<void>>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();
  private readonly maximumArtifactBytes: number;
  private readonly pollIntervalMs: number;

  public constructor(
    private readonly runtime: ScenarioRuntime,
    private readonly options: ScenarioGatewayOptions = {},
  ) {
    this.authority = {
      subjectId: options.authority?.subjectId ?? "local-user",
      clientId: options.authority?.clientId ?? "local-stdio",
      clientVersion: options.authority?.clientVersion ?? "2",
      scopes: options.authority?.scopes ?? scenarioGatewayScopes,
      visibilityScope: options.authority?.visibilityScope ?? [
        "public",
        "localSensitive",
        "artifactReference",
        "redacted",
      ],
    };
    this.maximumArtifactBytes = options.maximumArtifactBytes ?? MAXIMUM_ARTIFACT_BYTES;
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  public async handle(input: ScenarioGatewayRequest): Promise<ScenarioGatewayResponse> {
    const request = scenarioGatewayRequestSchema.parse(input);
    const payload = request.payload;
    try {
      this.requireScope(scenarioGatewayOperationScopes[payload.operation]);
      switch (payload.operation) {
        case "listRuns": {
          const runs = await this.runtime.listRuns();
          return success(request.requestId, {
            kind: "runs",
            runs: runs.map((run) => ({
              runId: run.runId,
              status: run.status,
              source: this.visibilityAllowed("localSensitive") ? run.source : { kind: run.source.kind },
              workingDir: this.visibilityAllowed("localSensitive") ? run.workingDir : null,
              updatedAt: run.updatedAt,
              capabilities: run.capabilities,
            })),
          });
        }
        case "startProviderRun": {
          const providerHost = this.requireProviderHost();
          return success(request.requestId, {
            kind: "accepted",
            result: await providerHost.start(payload.config),
          });
        }
        case "resumeProviderRun": {
          const providerHost = this.requireProviderHost();
          return success(request.requestId, {
            kind: "accepted",
            result: await providerHost.resume(payload.runId, payload.config, payload.target),
          });
        }
        case "sendConversationInput": {
          await this.requireProviderHost().send(payload.runId, payload.turnId, payload.input);
          return success(request.requestId, {
            kind: "accepted",
            result: { runId: payload.runId, turnId: payload.turnId, accepted: true },
          });
        }
        case "cancelProviderTurn": {
          await this.requireProviderHost().cancel(payload.runId, payload.turnId);
          return success(request.requestId, {
            kind: "accepted",
            result: { runId: payload.runId, turnId: payload.turnId, cancelled: true },
          });
        }
        case "closeProviderRun": {
          await this.requireProviderHost().close(payload.runId);
          return success(request.requestId, {
            kind: "accepted",
            result: { runId: payload.runId, closed: true },
          });
        }
        case "attachRun": {
          const snapshot = this.projectSnapshot(await this.runtime.snapshot(payload.runId));
          return success(request.requestId, { kind: "attached", snapshot, cursor: snapshot.lastRecordSeq });
        }
        case "getSnapshot":
          return success(request.requestId, {
            kind: "snapshot",
            snapshot: this.projectSnapshot(await this.runtime.snapshot(payload.runId)),
          });
        case "recordsAfter": {
          const snapshot = await this.runtime.snapshot(payload.runId);
          this.assertCursor(payload.afterSeq, snapshot);
          const batches = await this.runtime.committedBatchesAfter(payload.runId, payload.afterSeq);
          return success(request.requestId, {
            kind: "records",
            records: batches.flatMap((batch) => batch.records).map((record) =>
              this.projectRecord(record)
            ),
          });
        }
        case "subscribe":
          await this.startSubscription(payload.runId, payload.afterSeq);
          return success(request.requestId, {
            kind: "accepted",
            result: { runId: payload.runId, afterSeq: payload.afterSeq, subscribed: true },
          });
        case "unsubscribe":
          this.stopSubscription(payload.runId);
          return success(request.requestId, {
            kind: "accepted",
            result: { runId: payload.runId, subscribed: false },
          });
        case "dispatch":
          return success(request.requestId, {
            kind: "accepted",
            result: await this.runtime.dispatch(await this.secureCommand(payload.command)),
          });
        case "submitToolDecision": {
          const result = await this.runtime.dispatch(this.gatewayCommand(payload.runId, {
            type: "toolDecisionSubmitted",
            toolCallId: payload.toolCallId,
            decision: payload.decision,
            reason: payload.reason,
          }, payload.expectedSnapshotRevision));
          let providerCoordination:
            | "settled"
            | "providerDetached"
            | "providerCancelled"
            | "coordinationFailed" = "providerDetached";
          if (this.options.providerHost?.settleToolDecision) {
            try {
              providerCoordination = await this.options.providerHost.settleToolDecision(
                payload.runId,
                payload.toolCallId,
                payload.decision,
                payload.reason,
              );
            } catch (error) {
              let cleanupError: unknown;
              try {
                await this.options.providerHost.cancel(payload.runId, null);
                providerCoordination = "providerCancelled";
              } catch (providerCleanupError) {
                cleanupError = providerCleanupError;
                providerCoordination = "coordinationFailed";
              }
              await this.recordDiagnosticSafely(
                payload.runId,
                `Provider tool-decision coordination failed: ${errorMessage(error)}; ` +
                  (cleanupError === undefined
                    ? "provider run cancelled and detached"
                    : `provider cancellation also failed: ${errorMessage(cleanupError)}`),
                "providerCoordination",
                payload.operation,
              );
            }
          }
          return success(request.requestId, {
            kind: "accepted",
            result: {
              ...result,
              data: { ...(result.data ?? {}), providerCoordination },
            },
          });
        }
        case "submitFeedback": {
          const dispatchResult = await this.runtime.dispatch(this.gatewayCommand(payload.runId, {
            type: "submitFeedback",
            targetKind: payload.targetKind,
            targetId: payload.targetId,
            vote: payload.vote,
            ...(payload.note === undefined ? {} : { note: payload.note }),
            idempotencyKey: payload.idempotencyKey,
            ...(payload.expectedTargetDigest === undefined
              ? {} : { expectedTargetDigest: payload.expectedTargetDigest }),
            ...(payload.targetRecordSeq === undefined ? {} : { targetRecordSeq: payload.targetRecordSeq }),
            author: {
              subjectId: this.authority.subjectId,
              clientId: this.authority.clientId,
              clientVersion: this.authority.clientVersion,
            },
          }));
          const feedbackId = dispatchResult.data?.feedbackId;
          if (typeof feedbackId !== "string") {
            throw new Error("Feedback dispatch result omitted its canonical feedback ID");
          }
          const effective = await this.runtime.feedbackById(payload.runId, feedbackId);
          if (!effective) throw new Error("Committed feedback was absent from canonical journal history");
          return success(request.requestId, {
            kind: "accepted",
            result: effective,
          });
        }
        case "fetchArtifact":
          return success(request.requestId, await this.fetchArtifact(payload.runId, payload.artifact));
      }
    } catch (error) {
      const code = gatewayErrorCode(error);
      if (code === "gateway_error" && "runId" in payload && typeof payload.runId === "string") {
        await this.recordDiagnosticSafely(
          payload.runId,
          `Gateway operation failed: ${errorMessage(error)}`,
          "scenarioGateway",
          payload.operation,
        );
      }
      return scenarioGatewayResponseSchema.parse({
        type: "response",
        requestId: request.requestId,
        ok: false,
        payload: {
          kind: "error",
          code,
          message: code === "gateway_error"
            ? "Gateway operation failed"
            : errorMessage(error),
          recoverable: true,
        },
      });
    }
  }

  public async dispose(): Promise<void> {
    for (const runId of [...this.subscriptions.keys()]) this.stopSubscription(runId);
    await Promise.allSettled([...this.activePolls]);
  }

  private async recordDiagnosticSafely(
    runId: string,
    message: string,
    source: string,
    operation: ScenarioGatewayRequest["payload"]["operation"],
  ): Promise<void> {
    try {
      await this.runtime.recordDiagnostic(runId, message, source);
    } catch (error) {
      this.reportBackgroundError(error, { operation, runId });
    }
  }

  private reportBackgroundError(
    error: unknown,
    context: { operation: ScenarioGatewayRequest["payload"]["operation"]; runId: string | null },
  ): void {
    reportBackgroundError({
      error,
      context,
      onBackgroundError: this.options.onBackgroundError,
      renderMessage: (failure, details) =>
        `Scenario gateway background failure for ${details.operation}` +
        `${details.runId ? ` on ${details.runId}` : ""}: ${errorMessage(failure)}`,
      reportingFailurePrefix: "Scenario gateway background error reporting failed",
    });
  }

  private async startSubscription(runId: string, afterSeq: number): Promise<void> {
    if (!this.options.emit) throw new Error("Gateway event streaming is unavailable");
    const initialSnapshot = await this.runtime.snapshot(runId);
    this.assertCursor(afterSeq, initialSnapshot);
    this.stopSubscription(runId);
    let cursor = afterSeq;
    let polling = false;
    let catchingUp = true;
    let stopped = false;
    const liveBatches: EventBatch[] = [];
    const emitBatch = (batch: EventBatch): void => {
      try {
        if (stopped) return;
        if (batch.toSeq <= cursor) return;
        if (batch.fromSeq !== cursor + 1) {
          const expectedNextSeq = cursor + 1;
          this.stopSubscription(runId);
          this.emitResyncRequired(runId, expectedNextSeq, batch.fromSeq, "Committed batch cursor is not contiguous");
          return;
        }
        const emitted = this.emitEvent(runId, {
          type: "eventBatch",
          batch: eventBatchSchema.parse({
            ...batch,
            records: batch.records.map((record) => this.projectRecord(record)),
          }),
        });
        if (emitted) cursor = batch.toSeq;
      } catch (error) {
        const expectedNextSeq = cursor + 1;
        this.reportBackgroundError(error, { operation: "subscribe", runId });
        this.emitResyncRequired(
          runId,
          expectedNextSeq,
          null,
          errorMessage(error),
        );
        this.stopSubscription(runId);
      }
    };
    const poll = async (): Promise<void> => {
      if (polling) return;
      polling = true;
      try {
        const batches = await this.runtime.committedBatchesAfter(runId, cursor);
        if (stopped) return;
        for (const batch of batches) emitBatch(batch);
      } catch (error) {
        if (stopped) return;
        const expectedNextSeq = cursor + 1;
        this.stopSubscription(runId);
        this.emitResyncRequired(
          runId,
          expectedNextSeq,
          null,
          errorMessage(error),
        );
      } finally {
        polling = false;
      }
    };
    const unsubscribeRuntime = this.runtime.subscribe(runId, (batch) => {
      const parsed = eventBatchSchema.parse(batch);
      if (catchingUp) liveBatches.push(parsed);
      else emitBatch(parsed);
    });
    const interval = setInterval(() => { void this.trackPoll(poll()); }, this.pollIntervalMs);
    interval.unref();
    this.subscriptions.set(runId, {
      stop: () => {
        stopped = true;
        unsubscribeRuntime();
        clearInterval(interval);
      },
    });
    await this.trackPoll(poll());
    catchingUp = false;
    liveBatches.sort((left, right) => left.fromSeq - right.fromSeq);
    for (const batch of liveBatches) emitBatch(batch);
  }

  private stopSubscription(runId: string): void {
    this.subscriptions.get(runId)?.stop();
    this.subscriptions.delete(runId);
  }

  private trackPoll(poll: Promise<void>): Promise<void> {
    this.activePolls.add(poll);
    void poll.then(
      () => this.activePolls.delete(poll),
      () => this.activePolls.delete(poll),
    );
    return poll;
  }

  private async secureCommand(command: ScenarioCommand): Promise<ScenarioCommand> {
    if (!CLIENT_DISPATCH_COMMANDS.has(command.payload.type)) {
      throw new Error(`Command is not accepted from gateway clients: ${command.payload.type}`);
    }
    if (command.payload.type !== "startRun") {
      const owner = (await this.runtime.snapshot(command.runId)).manifest.source.kind;
      if (owner !== "gateway") {
        throw new Error(`Gateway dispatch cannot mutate ${owner}-owned run: ${command.runId}`);
      }
    }
    const payload = command.payload.type === "submitFeedback"
      ? {
          ...command.payload,
          author: {
            subjectId: this.authority.subjectId,
            clientId: this.authority.clientId,
            clientVersion: this.authority.clientVersion,
          },
        }
      : command.payload;
    return createScenarioCommandEnvelope({
      commandId: command.commandId,
      runId: command.runId,
      source: { kind: "gateway" },
      expectedSnapshotRevision: command.expectedSnapshotRevision,
      correlationId: command.correlationId,
      causationId: command.causationId,
      payload,
    });
  }

  private gatewayCommand(
    runId: string,
    payload: ScenarioCommand["payload"],
    expectedSnapshotRevision?: number,
  ): ScenarioCommand {
    return createScenarioCommandEnvelope({
      runId,
      source: { kind: "gateway" },
      expectedSnapshotRevision,
      payload,
    });
  }

  private projectRecord(record: ScenarioRecord): ScenarioRecord {
    if (this.visibilityAllowed(record.visibility)) {
      let projected = record;
      if (record.eventType === "artifact.linked") {
        const artifact = artifactRefSchema.safeParse(record.payload.artifact);
        if (artifact.success && !this.visibilityAllowed(artifact.data.visibility)) {
          const { preview: _preview, ...reference } = artifact.data;
          projected = { ...record, payload: { ...record.payload, artifact: reference } };
        }
      }
      return this.visibilityAllowed("localSensitive")
        ? projected
        : this.stripSensitiveRecordMetadata(projected);
    }
    return this.stripSensitiveRecordMetadata({
      ...record,
      visibility: "redacted",
      payload: {
        redacted: true,
        reason: `Visibility ${record.visibility} is outside the negotiated scope`,
        originalType: "object",
      },
    });
  }

  private stripSensitiveRecordMetadata(record: ScenarioRecord): ScenarioRecord {
    const {
      correlationId: _correlationId,
      causationId: _causationId,
      entityRef: _entityRef,
      ...publicRecord
    } = record;
    return {
      ...publicRecord,
      recordId: `public-record-${record.recordSeq}`,
      commandId: `public-command-${record.recordSeq}`,
    };
  }

  private projectSnapshot(snapshot: ScenarioSnapshot): ScenarioSnapshot {
    const projected = structuredClone(snapshot);
    for (const [key, slice] of Object.entries(projected.stateSlices)) {
      if (this.visibilityAllowed(slice.visibility)) continue;
      delete projected.stateSlices[key];
    }
    projected.artifacts = projected.artifacts.filter((artifact) => this.visibilityAllowed(artifact.visibility));
    if (!this.visibilityAllowed("localSensitive")) {
      projected.identity.workingDir = null;
      projected.identity.projectDir = null;
      projected.manifest.source = { kind: projected.manifest.source.kind };
      projected.manifest.adapter = null;
      projected.manifest.provider = null;
      projected.manifest.nativeSessionIds = [];
      projected.manifest.runtimeHome.configuration = {};
      projected.manifest.configuration = {};
      for (const message of projected.conversation) {
        message.content = "[redacted]";
        message.contentDigest = digestScenarioValue(message.content);
        delete message.usage;
      }
      for (const tool of projected.toolCalls) {
        tool.input = { redacted: true, reason: "Tool input is local-sensitive", originalType: valueType(tool.input) };
        tool.inputDigest = digestScenarioValue(tool.input);
        tool.feedbackDigest = digestScenarioValue({ status: tool.status, inputDigest: tool.inputDigest });
        tool.output = [];
        tool.error = tool.error === null ? null : "[redacted]";
        tool.authorization.reason = tool.authorization.reason === null ? null : "[redacted]";
      }
      projected.commandResults = {};
      projected.providerState = {};
      projected.plan = {};
      projected.continuation = {};
      projected.feedback = {};
      projected.errors = [];
      projected.recoveryDiagnostics = [];
      projected.effects = [];
    }
    return scenarioSnapshotSchema.parse(projected);
  }

  private async fetchArtifact(runId: string, artifact: ArtifactRef) {
    const snapshot = await this.runtime.snapshot(runId);
    if (!snapshot.capabilities.artifactRead) throw new Error("Run does not allow artifact reads");
    const authorized = snapshot.artifacts.find((candidate) =>
      candidate.artifactId === artifact.artifactId && candidate.digest === artifact.digest
    );
    if (!authorized) throw new Error("Artifact is not linked to the requested run");
    if (!this.visibilityAllowed(authorized.visibility)) throw new Error("Artifact visibility is not authorized");
    const loaded = await this.runtime.readArtifact(runId, artifact, this.maximumArtifactBytes);
    const canonical = loaded.artifact;
    return {
      kind: "artifact" as const,
      artifact: canonical,
      bytesBase64: Buffer.from(loaded.bytes).toString("base64"),
    };
  }

  private emitResyncRequired(
    runId: string,
    expectedNextSeq: number,
    receivedFromSeq: number | null,
    reason: string,
  ): boolean {
    return this.emitEvent(runId, {
      type: "resyncRequired",
      runId,
      expectedNextSeq,
      receivedFromSeq,
      reason,
    });
  }

  private emitEvent(runId: string, event: ScenarioGatewayEvent): boolean {
    try {
      this.options.emit?.(event);
      return true;
    } catch (error) {
      this.stopSubscription(runId);
      this.reportBackgroundError(error, { operation: "subscribe", runId });
      return false;
    }
  }

  private visibilityAllowed(visibility: ScenarioVisibility): boolean {
    if (visibility === "public" || visibility === "redacted" || visibility === "artifactReference") return true;
    if (visibility === "authorizedSensitive" && !this.authority.scopes.includes("state.inspectSensitive")) return false;
    return this.authority.visibilityScope.includes(visibility);
  }

  private requireScope(scope: string): void {
    if (!this.authority.scopes.includes(scope)) throw new Error(`Missing gateway scope: ${scope}`);
  }

  private requireProviderHost(): ScenarioProviderHost {
    if (!this.options.providerHost) throw new Error("Provider hosting is unavailable");
    return this.options.providerHost;
  }

  private assertCursor(cursor: number, snapshot: ScenarioSnapshot): void {
    if (cursor > snapshot.lastRecordSeq) {
      throw new Error(`Cursor gap: ${cursor} is beyond committed sequence ${snapshot.lastRecordSeq}`);
    }
  }
}

const CLIENT_DISPATCH_COMMANDS = new Set<ScenarioCommand["payload"]["type"]>([
  "startRun",
  "resumeRun",
  "closeRun",
  "cancelRun",
  "userMessageSubmitted",
  "planStateChanged",
]);

function success(
  requestId: string,
  payload: ScenarioGatewayResponse["payload"],
): ScenarioGatewayResponse {
  return scenarioGatewayResponseSchema.parse({ type: "response", requestId, ok: true, payload });
}

function gatewayErrorCode(error: unknown): ScenarioGatewayErrorCode {
  const message = errorMessage(error);
  if (
    message.startsWith("Missing gateway scope") ||
    message.startsWith("Gateway dispatch cannot mutate")
  ) return "permission_denied";
  if (
    message.startsWith("Cursor gap") ||
    message.includes("splits committed batch") ||
    message.includes("splits or gaps a committed batch")
  ) return "cursor_gap";
  if (error instanceof SnapshotRevisionConflictError) return "snapshot_revision_conflict";
  if (error instanceof FeedbackTargetConflictError) return "feedback_target_conflict";
  return "gateway_error";
}

function valueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
