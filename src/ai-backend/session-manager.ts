import type {
  AiBackendMessage,
  AiEvent,
  AiMessageId,
  AiRequest,
  AiSessionConfig,
  AiToolDecision,
  SessionId,
  TokenUsage,
  ToolCallId,
  TurnId,
} from "../ai-protocol/index.js";
import { TranscriptStore } from "./transcript-store.js";
import { createResolvedProviderRunner, resolveSessionProvider, type AiProviderRunner } from "./provider.js";
import { ProviderState } from "./provider-state.js";
import type { AiRuntimeEvent } from "./runtime-events.js";
import { protocolError, toPublicError } from "./public-errors.js";

type WriteFrame = (frame: AiBackendMessage) => void;
type RunningTurn = {
  sessionId: SessionId;
  turnId: TurnId;
  controller: AbortController;
};
type RunningTurnPromise = {
  sessionId: SessionId;
  promise: Promise<void>;
};
type Ticker = ReturnType<typeof setInterval>;
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
  readonly #providerStates = new Map<SessionId, ProviderState>();
  readonly #tickers = new Map<string, Ticker>();
  readonly #toolRunningSince = new Map<string, string>();
  readonly #processRunningSince = new Map<string, string>();

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
      case "startSession":
        await this.startSession(request.sessionId, request.config);
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
        this.emitSessionUpdated(request.sessionId);
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
    if (this.hasRunningTurn(sessionId)) {
      this.writeResponseError(sessionId, "conflict", `AI session has a running turn: ${sessionId}`);
      return;
    }

    let runner: AiProviderRunner;
    try {
      const resolvedProvider = resolveSessionProvider(config);
      runner = createResolvedProviderRunner(resolvedProvider);
    } catch (error) {
      this.writeResponseError(sessionId, "runtime_error", error instanceof Error ? error.message : String(error));
      return;
    }
    void this.#runners.get(sessionId)?.dispose?.();
    this.#runners.set(sessionId, runner);
    this.#providerStates.set(sessionId, new ProviderState());
    const snapshot = this.#store.create(sessionId, config);
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
    const state = this.#providerStates.get(sessionId) ?? new ProviderState();
    this.#providerStates.set(sessionId, state);
    state.resetRuntimeRefs();
    const controller = new AbortController();
    this.#turns.set(turnKey(sessionId, turnId), { sessionId, turnId, controller });
    this.#store.setStatus(sessionId, "running");
    this.#write({
      type: "response",
      response: { type: "accepted", sessionId, turnId },
    });
    this.emit(sessionId, { type: "turnStarted", sessionId, turnId });
    const now = new Date().toISOString();
    const message = this.#store.appendMessage(sessionId, {
      id: state.nextMessageId(),
      turnId,
      role: "user",
      content: input,
      status: "completed",
      createdAt: now,
    });
    this.emit(sessionId, { type: "messageCreated", sessionId, turnId, message });
    this.emitSessionUpdated(sessionId);

    const key = turnKey(sessionId, turnId);
    const turnPromise = this.runTurn(sessionId, turnId, input, controller, baseConfig);
    this.#turnPromises.set(key, { sessionId, promise: turnPromise });
    void turnPromise;
  }

  private async runTurn(
    sessionId: SessionId,
    turnId: TurnId,
    input: string,
    controller: AbortController,
    turnConfig?: AiSessionConfig
  ): Promise<void> {
    let usage: TokenUsage | null = null;
    let failed = false;
    try {
      const config = turnConfig ?? this.#store.getConfig(sessionId);
      if (!config) throw new Error(`Unknown AI session config: ${sessionId}`);
      const runner = this.#runners.get(sessionId);
      if (!runner) throw new Error(`Unknown AI session runtime: ${sessionId}`);
      this.startTicker(sessionId, turnId);
      for await (const event of runner.runTurn({ config, prompt: input, turnId, signal: controller.signal })) {
        const eventUsage = this.applyRuntimeEvent(sessionId, turnId, event);
        if (eventUsage) usage = eventUsage;
        if (event.type === "error" || event.type === "message.failed") failed = true;
      }
      if (!failed) {
        const updated = this.#store.setStatus(sessionId, "idle");
        this.emit(sessionId, { type: "sessionUpdated", sessionId, snapshot: updated });
      }
      this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage });
    } catch (error) {
      if (controller.signal.aborted) {
        const now = new Date().toISOString();
        const cancelled = this.#store.cancelActiveOperations(sessionId, turnId, now);
        for (const toolCall of cancelled.tools) {
          this.#toolRunningSince.delete(toolKey(sessionId, toolCall.id));
          this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        }
        for (const process of cancelled.processes) {
          this.#processRunningSince.delete(processKey(sessionId, process.id));
          this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        }
        const updated = this.#store.setStatus(sessionId, "cancelled", toPublicError(error));
        this.emit(sessionId, { type: "sessionUpdated", sessionId, snapshot: updated });
        this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage: null });
      } else {
        const now = new Date().toISOString();
        const cancelled = this.#store.cancelActiveOperations(sessionId, turnId, now);
        for (const toolCall of cancelled.tools) {
          this.#toolRunningSince.delete(toolKey(sessionId, toolCall.id));
          this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        }
        for (const process of cancelled.processes) {
          this.#processRunningSince.delete(processKey(sessionId, process.id));
          this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        }
        const publicError = toPublicError(error);
        this.writeProtocolError(sessionId, turnId, publicError.code, publicError.message);
        this.emit(sessionId, { type: "turnFinished", sessionId, turnId, usage: null });
      }
    } finally {
      const key = turnKey(sessionId, turnId);
      this.stopTicker(key);
      this.#turns.delete(key);
      this.#turnPromises.delete(key);
    }
  }

  private applyRuntimeEvent(sessionId: SessionId, turnId: TurnId, event: AiRuntimeEvent): TokenUsage | null {
    const state = this.#providerStates.get(sessionId) ?? new ProviderState();
    this.#providerStates.set(sessionId, state);
    const now = event.createdAt ?? new Date().toISOString();
    switch (event.type) {
      case "message.created": {
        const id = state.messageId(event.ref);
        const message = this.#store.appendMessage(sessionId, {
          id,
          turnId,
          role: "assistant",
          content: event.content ?? "",
          status: "streaming",
          createdAt: now,
        });
        this.emit(sessionId, { type: "messageCreated", sessionId, turnId, message });
        return null;
      }
      case "message.delta": {
        const messageId = state.messageId(event.ref);
        this.ensureMessage(sessionId, turnId, messageId, now);
        this.#store.appendMessageDelta(sessionId, messageId, event.delta, now);
        this.emit(sessionId, { type: "messageDelta", sessionId, turnId, messageId, delta: event.delta });
        return null;
      }
      case "message.reasoning_delta": {
        const messageId = state.messageId(event.ref);
        this.ensureMessage(sessionId, turnId, messageId, now);
        this.#store.appendReasoningDelta(sessionId, messageId, event.delta, now);
        this.emit(sessionId, { type: "messageReasoningDelta", sessionId, turnId, messageId, delta: event.delta });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "message.completed": {
        const messageId = state.messageId(event.ref);
        this.ensureMessage(sessionId, turnId, messageId, now);
        const message = this.#store.completeMessage(
          sessionId,
          messageId,
          now,
          "completed",
          event.usage ?? null,
          event.content
        );
        this.emit(sessionId, { type: "messageCompleted", sessionId, turnId, message, usage: event.usage ?? null });
        this.emitSessionUpdated(sessionId);
        return event.usage ?? null;
      }
      case "message.failed": {
        const messageId = state.messageId(event.ref);
        this.ensureMessage(sessionId, turnId, messageId, now);
        const error = toPublicError(event.error);
        this.#store.completeMessage(sessionId, messageId, now, "failed", null);
        this.writeProtocolError(sessionId, turnId, error.code, error.message);
        return null;
      }
      case "tool.created": {
        const toolCall = this.#store.createTool(sessionId, {
          id: state.toolId(event.ref),
          turnId,
          name: event.name,
          summary: event.input,
          now,
        });
        this.emit(sessionId, { type: "toolCallCreated", sessionId, turnId, toolCall });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "tool.updated": {
        const id = state.toolId(event.ref);
        if (event.status === "running") this.markToolRunning(sessionId, id, now);
        const toolCall = this.#store.updateTool(sessionId, state.toolId(event.ref), now, {
          status: event.status,
          wait: event.status === "waiting" ? { reason: event.waitReason ?? null, since: now } : null,
        });
        this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "tool.progress": {
        const id = state.toolId(event.ref);
        this.markToolRunning(sessionId, id, now);
        const toolCall = this.#store.updateTool(sessionId, id, now, {
          progress: event.progress,
          elapsedMs: elapsed(this.#toolRunningSince.get(toolKey(sessionId, id)), now),
        });
        this.emit(sessionId, {
          type: "toolCallProgress",
          sessionId,
          turnId,
          toolCallId: toolCall.id,
          progress: toolCall.progress,
          elapsedMs: toolCall.elapsedMs,
        });
        return null;
      }
      case "tool.output": {
        const toolCall = this.#store.updateTool(sessionId, state.toolId(event.ref), now, { output: event.output });
        this.emit(sessionId, { type: "toolCallOutput", sessionId, turnId, toolCallId: toolCall.id, output: event.output });
        return null;
      }
      case "tool.completed": {
        const id = state.toolId(event.ref);
        const toolCall = this.#store.updateTool(sessionId, id, now, {
          status: "completed",
          ...(event.output ? { output: event.output } : {}),
          result: { state: "completed", output: [], error: null },
        });
        this.#toolRunningSince.delete(toolKey(sessionId, id));
        this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        this.emitSessionUpdated(sessionId);
        return event.usage ?? null;
      }
      case "tool.failed": {
        const error = toPublicError(event.error);
        const id = state.toolId(event.ref);
        const toolCall = this.#store.updateTool(sessionId, id, now, {
          status: "failed",
          result: { state: "failed", output: [], error },
        });
        this.#toolRunningSince.delete(toolKey(sessionId, id));
        this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "tool.cancelled": {
        const id = state.toolId(event.ref);
        const toolCall = this.#store.updateTool(sessionId, id, now, {
          status: "cancelled",
          result: { state: "cancelled", output: [], error: null },
        });
        this.#toolRunningSince.delete(toolKey(sessionId, id));
        this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "backend_process.created": {
        const process = this.#store.createBackendProcess(sessionId, {
          id: state.processId(event.ref),
          turnId,
          title: event.title,
          cancellable: event.cancellable ?? false,
          now,
        });
        this.emit(sessionId, { type: "backendProcessCreated", sessionId, turnId, process });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "backend_process.updated": {
        const id = state.processId(event.ref);
        if (event.status === "running") this.markProcessRunning(sessionId, id, now);
        const process = this.#store.updateBackendProcess(sessionId, id, now, {
          status: event.status,
        });
        this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "backend_process.progress": {
        const id = state.processId(event.ref);
        this.markProcessRunning(sessionId, id, now);
        const process = this.#store.updateBackendProcess(sessionId, id, now, {
          progress: event.progress,
          elapsedMs: elapsed(this.#processRunningSince.get(processKey(sessionId, id)), now),
        });
        this.emit(sessionId, {
          type: "backendProcessProgress",
          sessionId,
          turnId,
          processId: process.id,
          progress: process.progress,
          elapsedMs: process.elapsedMs,
        });
        return null;
      }
      case "backend_process.output": {
        const process = this.#store.updateBackendProcess(sessionId, state.processId(event.ref), now, {
          output: event.output,
        });
        this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        return null;
      }
      case "backend_process.completed": {
        const id = state.processId(event.ref);
        const process = this.#store.updateBackendProcess(sessionId, id, now, {
          status: "completed",
          ...(event.output ? { output: event.output } : {}),
        });
        this.#processRunningSince.delete(processKey(sessionId, id));
        this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        this.emitSessionUpdated(sessionId);
        return event.usage ?? null;
      }
      case "backend_process.failed": {
        const id = state.processId(event.ref);
        const process = this.#store.updateBackendProcess(sessionId, id, now, {
          status: "failed",
          error: toPublicError(event.error),
        });
        this.#processRunningSince.delete(processKey(sessionId, id));
        this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "backend_process.cancelled": {
        const id = state.processId(event.ref);
        const process = this.#store.updateBackendProcess(sessionId, id, now, {
          status: "cancelled",
        });
        this.#processRunningSince.delete(processKey(sessionId, id));
        this.emit(sessionId, { type: "backendProcessUpdated", sessionId, turnId, process });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "tool.promoted_to_backend_process": {
        const process = this.#store.createBackendProcess(sessionId, {
          id: state.processId(event.processRef),
          turnId,
          title: event.title,
          cancellable: true,
          now,
        });
        const toolCall = this.#store.updateTool(sessionId, state.toolId(event.toolRef), now, {
          status: "completed",
          processId: process.id,
          result: { state: "movedToProcess", output: [], error: null },
        });
        this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall });
        this.emit(sessionId, { type: "backendProcessCreated", sessionId, turnId, process });
        this.emit(sessionId, {
          type: "toolCallPromotedToBackendProcess",
          sessionId,
          turnId,
          toolCallId: toolCall.id,
          processId: process.id,
        });
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "continuation.updated": {
        const snapshot = this.#store.get(sessionId);
        if (!snapshot) return null;
        const continuation = { ...snapshot.continuation, available: event.available, updatedAt: now };
        this.#store.setContinuation(sessionId, continuation);
        this.emit(sessionId, { type: "continuationUpdated", sessionId, continuation });
        this.emitSessionUpdated(sessionId);
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
        this.emitSessionUpdated(sessionId);
        return null;
      }
      case "error": {
        const error = toPublicError(event.error);
        this.writeProtocolError(sessionId, turnId, error.code, error.message);
        return null;
      }
    }
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
      const updatedTool = this.#store.updateTool(sessionId, decision.toolCallId, new Date().toISOString(), {
        status: "unsupported",
        result: { state: "unsupported", output: [], error },
      });
      this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall: updatedTool });
      this.emitSessionUpdated(sessionId);
      this.writeResponseError(sessionId, "runtime_error", error.message);
      return;
    }
    const state = this.#providerStates.get(sessionId);
    const runtimeToolRef = state?.toolRef(decision.toolCallId);
    if (!runtimeToolRef) {
      this.writeResponseError(sessionId, "invalid_request", `Tool is not waiting for a decision: ${decision.toolCallId}`);
      return;
    }
    try {
      await runner.submitToolDecision({ ...decision, toolCallId: runtimeToolRef });
      const updatedTool = this.#store.updateTool(sessionId, decision.toolCallId, new Date().toISOString(), {
        status: decision.decision === "approve" ? "approved" : "denied",
        wait: null,
        ...(decision.decision === "deny"
          ? { result: { state: "denied" as const, output: [], error: null } }
          : {}),
      });
      this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall: updatedTool });
      this.emitSessionUpdated(sessionId);
      this.#write({ type: "response", response: { type: "accepted", sessionId, turnId } });
    } catch (error) {
      const publicError = toPublicError(error);
      const updatedTool = this.#store.updateTool(sessionId, decision.toolCallId, new Date().toISOString(), {
        status: "failed",
        result: { state: "failed", output: [], error: publicError },
      });
      this.emit(sessionId, { type: "toolCallUpdated", sessionId, turnId, toolCall: updatedTool });
      this.emitSessionUpdated(sessionId);
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
    for (const tickerKey of this.#tickers.keys()) {
      this.stopTicker(tickerKey);
    }
    for (const turn of this.#turns.values()) {
      turn.controller.abort();
    }
    this.#turns.clear();
    const disposals = [...this.#runners.values()].map((runner) => runner.dispose?.());
    this.#runners.clear();
    await Promise.all(disposals);
  }

  private emitSessionUpdated(sessionId: SessionId): void {
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) return;
    this.emit(sessionId, { type: "sessionUpdated", sessionId, snapshot });
  }

  private emit(sessionId: SessionId, event: AiEventInput): void {
    const createdAt = event.createdAt ?? new Date().toISOString();
    const seq = this.#store.nextSeq(sessionId);
    const fullEvent = { ...event, seq, createdAt } as AiEvent;
    const recorded = this.#store.recordEvent(sessionId, fullEvent);
    this.#write({ type: "event", event: recorded });
  }

  private markToolRunning(sessionId: SessionId, id: ToolCallId, now: string): void {
    const key = toolKey(sessionId, id);
    if (!this.#toolRunningSince.has(key)) this.#toolRunningSince.set(key, now);
  }

  private markProcessRunning(sessionId: SessionId, id: string, now: string): void {
    const key = processKey(sessionId, id);
    if (!this.#processRunningSince.has(key)) this.#processRunningSince.set(key, now);
  }

  private writeProtocolError(
    sessionId: SessionId,
    turnId: TurnId | null,
    code: Parameters<typeof protocolError>[0] | "cancelled" | "runtime_error",
    message: string
  ): void {
    const error = code === "runtime_error" || code === "cancelled"
      ? (code === "cancelled"
          ? { code, message, recoverable: true }
          : toPublicError(message))
      : protocolError(code, message);
    if (this.#store.get(sessionId)) {
      const snapshot = this.#store.get(sessionId);
      const nextStatus = code === "runtime_error" ? "error" : snapshot?.status === "running" ? "running" : "idle";
      const updated = this.#store.setStatus(sessionId, nextStatus, error);
      this.emit(sessionId, { type: "sessionUpdated", sessionId, snapshot: updated });
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
    const error = code === "runtime_error"
      ? toPublicError(message)
      : protocolError(code, message);
    this.#write({ type: "response", response: { type: "error", sessionId, message: error.message, error } });
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

  private ensureMessage(sessionId: SessionId, turnId: TurnId, id: AiMessageId, now: string): void {
    const snapshot = this.#store.get(sessionId);
    if (snapshot?.transcript.some((item) => item.id === id)) return;
    const message = this.#store.appendMessage(sessionId, {
      id,
      turnId,
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: now,
    });
    this.emit(sessionId, { type: "messageCreated", sessionId, turnId, message });
  }

  private startTicker(sessionId: SessionId, turnId: TurnId): void {
    const key = turnKey(sessionId, turnId);
    this.stopTicker(key);
    const ticker = setInterval(() => {
      const snapshot = this.#store.get(sessionId);
      if (!snapshot) return;
      const now = new Date().toISOString();
      for (const tool of snapshot.toolCalls) {
        if (tool.turnId === turnId && ["waiting", "running", "delayed"].includes(tool.status)) {
          const start = this.#toolRunningSince.get(toolKey(sessionId, tool.id));
          if (!start) continue;
          const updated = this.#store.updateTool(sessionId, tool.id, now, {
            elapsedMs: elapsed(start, now),
          });
          this.emit(sessionId, {
            type: "toolCallProgress",
            sessionId,
            turnId,
            toolCallId: updated.id,
            progress: updated.progress,
            elapsedMs: updated.elapsedMs,
          });
        }
      }
      for (const process of snapshot.backendProcesses) {
        if (process.turnId === turnId && ["created", "running"].includes(process.status)) {
          const start = this.#processRunningSince.get(processKey(sessionId, process.id));
          if (!start) continue;
          const updated = this.#store.updateBackendProcess(sessionId, process.id, now, {
            elapsedMs: elapsed(start, now),
          });
          this.emit(sessionId, {
            type: "backendProcessProgress",
            sessionId,
            turnId,
            processId: updated.id,
            progress: updated.progress,
            elapsedMs: updated.elapsedMs,
          });
        }
      }
    }, 1000);
    ticker.unref?.();
    this.#tickers.set(key, ticker);
  }

  private stopTicker(key: string): void {
    const ticker = this.#tickers.get(key);
    if (!ticker) return;
    clearInterval(ticker);
    this.#tickers.delete(key);
  }
}

function turnKey(sessionId: SessionId, turnId: TurnId): string {
  return JSON.stringify([sessionId, turnId]);
}

function elapsed(start: string | undefined, now: string): number | null {
  if (!start) return null;
  return Math.max(0, Date.parse(now) - Date.parse(start));
}

function toolKey(sessionId: SessionId, id: ToolCallId): string {
  return JSON.stringify([sessionId, id]);
}

function processKey(sessionId: SessionId, id: string): string {
  return JSON.stringify([sessionId, id]);
}
