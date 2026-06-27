import type {
  AiBackendMessage,
  AiErrorInfo,
  AiRequestId,
  AiEvent,
  AiRequest,
  AiSessionConfig,
  AiSessionChoicesConfig,
  AiSessionSnapshot,
  AiToolDecision,
  SessionId,
  TokenUsage,
  TurnId,
} from "../ai-protocol/index.js";
import path from "node:path";
import { TranscriptStore } from "./transcript-store.js";
import {
  createResolvedProviderRunner,
  createResumeProviderRunner,
  providerMetadataForResolvedProvider,
  resolveSessionProvider,
  ResumeProviderMismatchError,
  type AiProviderRunner,
} from "./provider.js";
import type { AiRuntimeEvent } from "./runtime-events.js";
import { protocolError, toPublicError } from "./public-errors.js";
import { sessionHistoryService } from "./session-history.js";
import { assertManagedRuntimeHomeConfig } from "../providers/managed-runtime-home.js";

type WriteFrame = (frame: AiBackendMessage) => void;
type RunningTurn = {
  sessionId: SessionId;
  turnId: TurnId;
  controller: AbortController;
};
type RunningTurnPromise = {
  sessionId: SessionId;
  generation: number;
  promise: Promise<void>;
};
type AiEventInput = {
  [Type in AiEvent["type"]]: Omit<Extract<AiEvent, { type: Type }>, "seq" | "createdAt"> & {
    createdAt?: string;
  };
}[AiEvent["type"]];

export class AiBackendSessionManager {
  readonly #store = new TranscriptStore();
  readonly #write: WriteFrame;
  readonly #turns = new Map<string, RunningTurn>();
  readonly #turnPromises = new Map<string, RunningTurnPromise>();
  readonly #runners = new Map<SessionId, AiProviderRunner>();
  readonly #closing = new Set<SessionId>();
  readonly #sessionGenerations = new Map<SessionId, number>();

  constructor(write: WriteFrame) {
    this.#write = write;
  }

  async handle(frame: { type: "request"; request: AiRequest } | { type: "cancel"; sessionId: SessionId; turnId: TurnId | null }): Promise<void> {
    if (frame.type === "cancel") {
      this.cancel(frame.sessionId, frame.turnId);
      return;
    }
    await this.handleRequest(frame.request);
  }

  private async handleRequest(request: AiRequest): Promise<void> {
    switch (request.type) {
      case "listSessionChoices":
        await this.listSessionChoices(request.requestId, request.config);
        break;
      case "startSession":
        await this.startSession(request.sessionId, request.config);
        break;
      case "resumeSession":
        await this.resumeSession(request.requestId, request.sessionId, request.resumeId, request.config);
        break;
      case "closeSession":
        await this.closeSession(request.requestId, request.sessionId);
        break;
      case "sendInput":
        this.startTurn(request.sessionId, request.turnId, request.input);
        break;
      case "submitToolDecision":
        await this.submitToolDecision(request.sessionId, request.turnId, request.decision);
        break;
      case "setPlanState":
        if (!this.#store.get(request.sessionId)) {
          this.writeProtocolError(request.sessionId, null, "not_found", `Unknown AI session: ${request.sessionId}`);
          break;
        }
        this.#store.setPlan(request.sessionId, request.state);
        this.emit(request.sessionId, { type: "planStateChanged", sessionId: request.sessionId, state: request.state });
        break;
      case "getSessionSnapshot":
        this.writeSnapshotResponse(request.sessionId);
        break;
      case "eventsSince":
        this.writeEventsSinceResponse(request.sessionId, request.afterSeq);
        break;
    }
  }

  private async startSession(sessionId: SessionId, config: AiSessionConfig): Promise<void> {
    if (this.#closing.has(sessionId)) {
      this.writeResponseError(sessionId, "conflict", `AI session is closing: ${sessionId}`);
      return;
    }
    const normalizedConfig = this.normalizeStartConfig(config);
    if (normalizedConfig instanceof Error) {
      this.writeResponseError(sessionId, "invalid_request", normalizedConfig.message);
      return;
    }
    if (this.hasRunningTurn(sessionId)) {
      this.writeResponseError(sessionId, "conflict", `AI session has a running turn: ${sessionId}`);
      return;
    }

    let runner: AiProviderRunner;
    try {
      const resolvedProvider = resolveSessionProvider(normalizedConfig);
      runner = createResolvedProviderRunner(resolvedProvider);
    } catch (error) {
      this.writeResponseError(sessionId, "runtime_error", error instanceof Error ? error.message : String(error));
      return;
    }
    const snapshot = this.#store.create(
      sessionId,
      normalizedConfig,
      undefined,
      providerMetadataForResolvedProvider(runner.resolvedProvider)
    );
    this.replaceRunnerAndWriteSessionStarted(sessionId, runner, snapshot);
  }

  private async listSessionChoices(requestId: AiRequestId, config: AiSessionChoicesConfig): Promise<void> {
    try {
      const choices = await sessionHistoryService.listChoices(config);
      this.#write({
        type: "response",
        response: {
          type: "sessionChoices",
          requestId,
          sessions: choices.sessions,
          workingDirectories: choices.workingDirectories,
        },
      });
    } catch (error) {
      this.writeRequestError(requestId, undefined, "runtime_error", error instanceof Error ? error.message : String(error));
    }
  }

  private async resumeSession(
    requestId: AiRequestId,
    sessionId: SessionId,
    resumeId: string,
    config: AiSessionConfig
  ): Promise<void> {
    if (this.#closing.has(sessionId)) {
      this.writeRequestError(requestId, sessionId, "conflict", `AI session is closing: ${sessionId}`);
      return;
    }
    if (this.hasRunningTurn(sessionId)) {
      this.writeRequestError(requestId, sessionId, "conflict", `AI session has a running turn: ${sessionId}`);
      return;
    }
    const resolved = sessionHistoryService.resolve(resumeId);
    if (!resolved) {
      this.writeRequestError(requestId, sessionId, "not_found", "Resume target was not found.");
      return;
    }
    if (config.sdkRuntimeHome !== "managedAstral" || config.sdkRuntimeEnvironment !== "user") {
      this.writeRequestError(requestId, sessionId, "invalid_request", "Managed resume requires sdkRuntimeHome managedAstral and sdkRuntimeEnvironment user.");
      return;
    }
    const normalizedConfig = this.normalizeStartConfig({
      ...config,
      continuable: true,
      workingDir: config.workingDir ?? resolved.descriptor.workingDir,
    });
    if (normalizedConfig instanceof Error) {
      this.writeRequestError(requestId, sessionId, "invalid_request", normalizedConfig.message);
      return;
    }
    if (path.resolve(normalizedConfig.workingDir ?? process.cwd()) !== path.resolve(resolved.descriptor.workingDir)) {
      this.writeRequestError(requestId, sessionId, "invalid_request", "Resume working directory does not match the selected session.");
      return;
    }
    let runner: AiProviderRunner;
    try {
      runner = createResumeProviderRunner(normalizedConfig, resolved.target);
    } catch (error) {
      if (error instanceof ResumeProviderMismatchError) {
        this.writeRequestError(requestId, sessionId, "invalid_request", error.message);
        return;
      }
      this.writeRequestError(requestId, sessionId, "runtime_error", error instanceof Error ? error.message : String(error));
      return;
    }
    let snapshot: AiSessionSnapshot;
    try {
      snapshot = this.#store.createHydrated(
        sessionId,
        normalizedConfig,
        resolved.transcript,
        resolved.toolCalls,
        {
          agentFrameworkSessionDir: resolved.agentFrameworkSessionDir,
          provider: providerMetadataForResolvedProvider(runner.resolvedProvider),
        }
      );
    } catch (error) {
      this.writeRequestError(
        requestId,
        sessionId,
        "invalid_request",
        error instanceof Error ? error.message : String(error)
      );
      return;
    }
    this.replaceRunnerAndWriteSessionStarted(sessionId, runner, snapshot);
  }

  private async closeSession(requestId: AiRequestId, sessionId: SessionId): Promise<void> {
    if (this.#closing.has(sessionId)) {
      this.writeRequestError(requestId, sessionId, "conflict", `AI session is closing: ${sessionId}`);
      return;
    }
    if (!this.#store.get(sessionId)) {
      this.writeRequestError(requestId, sessionId, "not_found", `Unknown AI session: ${sessionId}`);
      return;
    }
    this.#closing.add(sessionId);
    let closeError: unknown = null;
    try {
      for (const turn of this.#turns.values()) {
        if (turn.sessionId === sessionId) turn.controller.abort();
      }
      for (const [key, turn] of [...this.#turns.entries()]) {
        if (turn.sessionId === sessionId) this.#turns.delete(key);
      }
      for (const [key, turn] of [...this.#turnPromises.entries()]) {
        if (turn.sessionId === sessionId) this.#turnPromises.delete(key);
      }
      await this.#runners.get(sessionId)?.dispose?.();
    } catch (error) {
      closeError = error;
    } finally {
      this.#runners.delete(sessionId);
      this.#store.delete(sessionId);
      this.#closing.delete(sessionId);
    }
    if (closeError) {
      this.writeRequestError(requestId, sessionId, "runtime_error", closeError instanceof Error ? closeError.message : String(closeError));
      return;
    }
    this.#write({ type: "response", response: { type: "sessionClosed", requestId, sessionId } });
  }

  private replaceRunnerAndWriteSessionStarted(
    sessionId: SessionId,
    runner: AiProviderRunner,
    snapshot: AiSessionSnapshot
  ): void {
    void this.#runners.get(sessionId)?.dispose?.();
    this.#sessionGenerations.set(sessionId, (this.#sessionGenerations.get(sessionId) ?? 0) + 1);
    this.#runners.set(sessionId, runner);
    this.#write({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: snapshot.sessionId,
        snapshot,
      },
    });
  }

  private startTurn(sessionId: SessionId, turnId: TurnId, input: string): void {
    if (this.#closing.has(sessionId)) {
      this.writeResponseError(sessionId, "conflict", `AI session is closing: ${sessionId}`);
      return;
    }
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) {
      this.writeProtocolError(sessionId, turnId, "not_found", `Unknown AI session: ${sessionId}`);
      return;
    }
    const baseConfig = this.#store.getConfig(sessionId);
    if (this.hasRunningTurn(sessionId)) {
      this.writeProtocolError(sessionId, turnId, "conflict", `AI session already has a running turn: ${sessionId}`);
      return;
    }
    const controller = new AbortController();
    this.#turns.set(turnKey(sessionId, turnId), { sessionId, turnId, controller });
    this.#store.setStatus(sessionId, "running");
    this.#store.addPendingUserMessage(sessionId, { turnId, content: input });
    this.#write({
      type: "response",
      response: { type: "accepted", sessionId, turnId },
    });
    this.emit(sessionId, { type: "turnStarted", sessionId, turnId });
    this.emitSessionStatusChanged(sessionId, "running");

    const key = turnKey(sessionId, turnId);
    const generation = this.#sessionGenerations.get(sessionId) ?? 0;
    const turnPromise = this.runTurn(sessionId, turnId, input, controller, baseConfig, generation);
    this.#turnPromises.set(key, { sessionId, generation, promise: turnPromise });
    void turnPromise;
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    input: string,
    controller: AbortController,
    turnConfig: AiSessionConfig | undefined,
    generation: number
  ): Promise<void> {
    let usage: TokenUsage | null = null;
    let failed = false;
    try {
      const config = turnConfig ?? this.#store.getConfig(sessionId);
      if (!config) throw new Error(`Unknown AI session config: ${sessionId}`);
      const runner = this.#runners.get(sessionId);
      if (!runner) throw new Error(`Unknown AI session runtime: ${sessionId}`);
      for await (const event of runner.runTurn({ config, prompt: input, turnId, signal: controller.signal })) {
        if (!this.isCurrentSessionGeneration(sessionId, generation)) return;
        const eventUsage = this.applyRuntimeEvent(sessionId, turnId, event);
        if (eventUsage) usage = eventUsage;
        if (event.type === "error") failed = true;
      }
      if (!this.isCurrentSessionGeneration(sessionId, generation)) return;
      if (!failed) {
        const finalized = this.#store.recordCompletedTurn(sessionId, { turnId });
        if (finalized) this.emitSessionUpdated(sessionId, finalized);
        this.#store.setStatus(sessionId, "idle");
        this.emitSessionStatusChanged(sessionId, "idle");
      }
      this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage });
    } catch (error) {
      if (!this.isCurrentSessionGeneration(sessionId, generation)) return;
      if (controller.signal.aborted) {
        const publicError = this.errorInfoForCode("cancelled", "Operation cancelled");
        const terminal = this.#store.recordTerminalTurn(sessionId, {
          turnId,
          status: "cancelled",
          error: publicError,
        });
        this.emitSessionUpdated(sessionId, terminal);
        const updated = this.#store.setStatus(sessionId, "cancelled", publicError);
        this.emitSessionStatusChanged(sessionId, updated.status, updated.error);
        this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage: null });
      } else {
        const publicError = toPublicError(error);
        this.appendProviderError(sessionId, publicError);
        const terminal = this.#store.recordTerminalTurn(sessionId, {
          turnId,
          status: "failed",
          error: publicError,
        });
        this.emitSessionUpdated(sessionId, terminal);
        this.writeProtocolError(sessionId, turnId, publicError.code, publicError.message);
        this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage: null });
      }
    } finally {
      const key = turnKey(sessionId, turnId);
      if (this.#turns.get(key)?.controller === controller) {
        this.#turns.delete(key);
      }
      if (this.#turnPromises.get(key)?.generation === generation) {
        this.#turnPromises.delete(key);
      }
    }
  }

  private applyRuntimeEvent(sessionId: SessionId, turnId: TurnId, event: AiRuntimeEvent): TokenUsage | null {
    const now = event.createdAt ?? new Date().toISOString();
    switch (event.type) {
      case "continuation.updated": {
        const snapshot = this.#store.get(sessionId);
        if (!snapshot) return null;
        const continuation = { ...snapshot.continuation, available: event.available, updatedAt: now };
        this.#store.setContinuation(sessionId, continuation);
        this.emit(sessionId, { type: "continuationUpdated", sessionId, continuation });
        return null;
      }
      case "plan.updated": {
        const snapshot = this.#store.get(sessionId);
        if (!snapshot) return null;
        const state = snapshot.plan.mode === "approved" && snapshot.plan.approved
          ? {
              ...event.state,
              mode: "approved" as const,
              approved: true,
              planText: event.state.planText ?? snapshot.plan.planText,
            }
          : event.state;
        this.#store.setPlan(sessionId, state);
        this.emit(sessionId, { type: "planStateChanged", sessionId, state });
        return null;
      }
      case "provider.metadata": {
        const snapshot = this.#store.setProvider(sessionId, event.provider);
        this.emitSessionUpdated(sessionId, snapshot);
        return null;
      }
      case "timeline.snapshot": {
        const snapshot = this.#store.replaceTimeline(sessionId, event.transcript, event.toolCalls, {
          agentFrameworkSessionDir: event.agentFrameworkSessionDir,
          provider: event.provider,
        });
        this.emitSessionUpdated(sessionId, snapshot);
        return event.provider?.usage ?? null;
      }
      case "turn.completed": {
        if (event.usage) {
          this.#store.setProvider(sessionId, { usage: event.usage });
        }
        return event.usage ?? null;
      }
      case "error": {
        const error = toPublicError(event.error);
        this.appendProviderError(sessionId, error);
        const snapshot = this.#store.recordTerminalTurn(sessionId, {
          turnId,
          status: "failed",
          error,
          createdAt: now,
        });
        this.emitSessionUpdated(sessionId, snapshot);
        this.writeProtocolError(sessionId, turnId, error.code, error.message);
        return null;
      }
    }
  }

  private appendProviderError(sessionId: SessionId, error: AiErrorInfo): void {
    const snapshot = this.#store.get(sessionId);
    const errors = [...(snapshot?.provider.errors ?? []), error];
    this.#store.setProvider(sessionId, { errors });
  }

  private async submitToolDecision(
    sessionId: SessionId,
    turnId: TurnId,
    decision: AiToolDecision
  ): Promise<void> {
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) {
      this.writeResponseError(sessionId, "not_found", `Unknown AI session: ${sessionId}`);
      return;
    }
    const tool = snapshot.toolCalls.find((item) => item.id === decision.toolCallId);
    if (!tool || tool.status !== "waiting") {
      this.writeResponseError(sessionId, "invalid_request", `Tool is not waiting for a decision: ${decision.toolCallId}`);
      return;
    }
    const runner = this.#runners.get(sessionId);
    if (!runner?.submitToolDecision) {
      const error = protocolError("invalid_request", "Manual tool approval is not supported by this runtime.");
      this.writeResponseError(sessionId, "runtime_error", error.message);
      return;
    }
    try {
      await runner.submitToolDecision(decision);
      this.#write({ type: "response", response: { type: "accepted", sessionId, turnId } });
    } catch (error) {
      const publicError = toPublicError(error);
      this.appendProviderError(sessionId, publicError);
      this.writeResponseError(sessionId, "runtime_error", publicError.message);
    }
  }

  private cancel(sessionId: SessionId, turnId: TurnId | null): void {
    if (turnId) {
      this.#turns.get(turnKey(sessionId, turnId))?.controller.abort();
    } else {
      for (const turn of this.#turns.values()) {
        if (turn.sessionId === sessionId) turn.controller.abort();
      }
    }
  }

  async dispose(): Promise<void> {
    for (const turn of this.#turns.values()) {
      turn.controller.abort();
    }
    this.#turns.clear();
    const disposals = [...this.#runners.values()].map((runner) => runner.dispose?.());
    this.#runners.clear();
    await Promise.all(disposals);
  }

  private emit(sessionId: SessionId, event: AiEventInput): void {
    if (this.#closing.has(sessionId) && event.type !== "sessionStatusChanged") return;
    if (!this.#store.get(sessionId)) return;
    const createdAt = event.createdAt ?? new Date().toISOString();
    const seq = this.#store.nextSeq(sessionId);
    const fullEvent = { ...event, seq, createdAt } as AiEvent;
    const recorded = this.#store.recordEvent(sessionId, fullEvent);
    this.#write({ type: "event", event: recorded.event, snapshot: recorded.snapshot });
  }

  private emitSessionStatusChanged(
    sessionId: SessionId,
    status: AiSessionSnapshot["status"],
    error: AiSessionSnapshot["error"] = null
  ): void {
    this.emit(sessionId, { type: "sessionStatusChanged", sessionId, status, error });
  }

  private emitSessionUpdated(sessionId: SessionId, snapshot: AiSessionSnapshot): void {
    this.emit(sessionId, { type: "sessionUpdated", sessionId, snapshot });
  }

  private isCurrentSessionGeneration(sessionId: SessionId, generation: number): boolean {
    return this.#store.get(sessionId) !== undefined && this.#sessionGenerations.get(sessionId) === generation;
  }

  private writeProtocolError(
    sessionId: SessionId,
    turnId: TurnId | null,
    code: Parameters<typeof protocolError>[0] | "cancelled" | "runtime_error",
    message: string
  ): void {
    const error = this.errorInfoForCode(code, message);
    if (this.#store.get(sessionId)) {
      const snapshot = this.#store.get(sessionId);
      const nextStatus = code === "runtime_error" ? "error" : snapshot?.status === "running" ? "running" : "idle";
      const updated = this.#store.setStatus(sessionId, nextStatus, error);
      this.emitSessionStatusChanged(sessionId, updated.status, updated.error);
    }
    if (this.#store.get(sessionId)) {
      this.emit(sessionId, { type: "error", sessionId, turnId, error, message: error.message });
    } else {
      this.#write({ type: "response", response: { type: "error", sessionId, message: error.message, error } });
    }
  }

  private writeResponseError(
    sessionId: SessionId | null,
    code: Parameters<typeof protocolError>[0] | "runtime_error",
    message: string
  ): void {
    const error = this.errorInfoForCode(code, message);
    this.#write({ type: "response", response: { type: "error", sessionId, message: error.message, error } });
  }

  private writeRequestError(
    requestId: AiRequestId,
    sessionId: SessionId | undefined,
    code: Parameters<typeof protocolError>[0] | "runtime_error",
    message: string
  ): void {
    const error = this.errorInfoForCode(code, message);
    this.#write({
      type: "response",
      response: {
        type: "requestError",
        requestId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
      },
    });
  }

  private errorInfoForCode(
    code: Parameters<typeof protocolError>[0] | "cancelled" | "runtime_error",
    message: string
  ) {
    if (code === "cancelled") return { code, message, recoverable: true };
    return code === "runtime_error" ? toPublicError(message) : protocolError(code, message);
  }

  private normalizeStartConfig(config: AiSessionConfig): AiSessionConfig | Error {
    try {
      assertManagedRuntimeHomeConfig(config);
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return {
      ...config,
      workingDir: path.resolve(config.workingDir ?? process.cwd()),
      sdkRuntimeHome: config.sdkRuntimeHome ?? "native",
    };
  }

  private writeSnapshotResponse(sessionId: SessionId): void {
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) {
      this.writeResponseError(sessionId, "not_found", `Unknown AI session: ${sessionId}`);
      return;
    }
    this.#write({ type: "response", response: { type: "sessionSnapshot", sessionId, snapshot } });
  }

  private writeEventsSinceResponse(sessionId: SessionId, afterSeq: number): void {
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) {
      this.writeResponseError(sessionId, "not_found", `Unknown AI session: ${sessionId}`);
      return;
    }
    this.#write({
      type: "response",
      response: {
        type: "sessionEvents",
        sessionId,
        events: this.#store.eventsSince(sessionId, afterSeq),
        snapshot,
      },
    });
  }

  private hasRunningTurn(sessionId: SessionId): boolean {
    for (const turn of this.#turns.values()) {
      if (turn.sessionId === sessionId) return true;
    }
    return false;
  }

}

function turnKey(sessionId: SessionId, turnId: TurnId): string {
  return JSON.stringify([sessionId, turnId]);
}
