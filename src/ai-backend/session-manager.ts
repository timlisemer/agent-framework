import type {
  AiBackendMessage,
  AiClientMessage,
  AiContentBlock,
  AiMessage,
  AiRequest,
  AiSessionConfig,
  AiTranscriptEntry,
  SessionId,
  TurnId,
} from "../ai-protocol/index.js";
import { TranscriptStore } from "./transcript-store.js";
import { createProviderRunner, resolveSessionProvider, type AiProviderRunner } from "./provider.js";

type WriteFrame = (frame: AiBackendMessage) => void;
type RunningTurn = {
  sessionId: SessionId;
  controller: AbortController;
};
type RunningTurnPromise = {
  sessionId: SessionId;
  promise: Promise<void>;
};

export class AiBackendSessionManager {
  readonly #store = new TranscriptStore();
  readonly #write: WriteFrame;
  readonly #turns = new Map<string, RunningTurn>();
  readonly #turnPromises = new Map<string, RunningTurnPromise>();
  readonly #runners = new Map<SessionId, AiProviderRunner>();

  constructor(write: WriteFrame) {
    this.#write = write;
  }

  async handle(frame: AiClientMessage): Promise<void> {
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
        this.#write({
          type: "response",
          response: {
            type: "error",
            sessionId: request.sessionId,
            message: "Manual tool approval is not supported by this provider in v1.",
          },
        });
        break;
      case "setPlanState":
        if (!this.#store.get(request.sessionId)) {
          this.writeError(request.sessionId, null, `Unknown AI session: ${request.sessionId}`);
          break;
        }
        this.#store.setPlan(request.sessionId, request.state);
        this.#write({
          type: "event",
          event: { type: "planStateChanged", sessionId: request.sessionId, state: request.state },
        });
        break;
    }
  }

  private async startSession(sessionId: SessionId, config: AiSessionConfig): Promise<void> {
    await this.waitForRunningTurns(sessionId);

    let resolvedProvider: ReturnType<typeof resolveSessionProvider>;
    let runner: AiProviderRunner;
    try {
      resolvedProvider = resolveSessionProvider(config);
      runner = createProviderRunner(config);
    } catch (error) {
      this.#write({
        type: "response",
        response: {
          type: "error",
          sessionId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    void this.#runners.get(sessionId)?.dispose?.();
    this.#runners.set(sessionId, runner);
    const resolvedConfig = { ...config, provider: config.provider ?? resolvedProvider.type };
    const snapshot = this.#store.create(sessionId, resolvedConfig);
    this.#write({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: snapshot.sessionId,
        snapshot,
      },
    });
  }

  private startTurn(
    sessionId: SessionId,
    turnId: TurnId,
    input: string
  ): void {
    const snapshot = this.#store.get(sessionId);
    if (!snapshot) {
      this.writeError(sessionId, turnId, `Unknown AI session: ${sessionId}`);
      return;
    }
    const baseConfig = this.#store.getConfig(sessionId);
    if (this.hasRunningTurn(sessionId)) {
      this.writeError(sessionId, turnId, `AI session already has a running turn: ${sessionId}`);
      return;
    }
    const controller = new AbortController();
    this.#turns.set(turnKey(sessionId, turnId), { sessionId, controller });
    this.#store.setStatus(sessionId, "running");
    this.#write({
      type: "response",
      response: { type: "accepted", sessionId, turnId },
    });
    this.#write({ type: "event", event: { type: "turnStarted", sessionId, turnId } });
    this.#store.append(sessionId, transcriptEntry(sessionId, turnId, "user", { type: "text", text: input }));
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
    try {
      const config = turnConfig ?? this.#store.getConfig(sessionId);
      if (!config) throw new Error(`Unknown AI session config: ${sessionId}`);
      const runner = this.#runners.get(sessionId);
      if (!runner) throw new Error(`Unknown AI session provider: ${sessionId}`);
      const result = await runner.runTurn(config, input, controller.signal);
      const assistant: AiMessage = {
        role: "assistant",
        content: [{ type: "text", text: result.text }],
      };
      this.#store.append(sessionId, {
        sessionId,
        turnId,
        message: assistant,
        usage: result.usage,
      });
      this.#store.setResume(sessionId, result.resume);
      this.#write({ type: "event", event: { type: "resumeMetadataUpdated", sessionId, resume: result.resume } });
      this.#write({
        type: "event",
        event: {
          type: "messageCompleted",
          sessionId,
          turnId,
          message: assistant,
          usage: result.usage,
        },
      });
      const updated = this.#store.setStatus(sessionId, "idle");
      this.#write({
        type: "event",
        event: { type: "sessionUpdated", sessionId, snapshot: updated },
      });
      this.#write({
        type: "event",
        event: { type: "turnFinished", sessionId, turnId, usage: result.usage },
      });
    } catch (error) {
      if (controller.signal.aborted) {
        const updated = this.#store.setStatus(sessionId, "cancelled");
        this.#write({
          type: "event",
          event: { type: "sessionUpdated", sessionId, snapshot: updated },
        });
        this.#write({
          type: "event",
          event: { type: "turnFinished", sessionId, turnId, usage: null },
        });
      } else {
        this.writeError(sessionId, turnId, error instanceof Error ? error.message : String(error));
        this.#write({
          type: "event",
          event: { type: "turnFinished", sessionId, turnId, usage: null },
        });
      }
    } finally {
      const key = turnKey(sessionId, turnId);
      this.#turns.delete(key);
      this.#turnPromises.delete(key);
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

  private writeError(sessionId: SessionId, turnId: TurnId | null, message: string): void {
    if (this.#store.get(sessionId)) {
      const updated = this.#store.setStatus(sessionId, "error", message);
      this.#write({
        type: "event",
        event: { type: "sessionUpdated", sessionId, snapshot: updated },
      });
    }
    this.#write({
      type: "event",
      event: { type: "error", sessionId, turnId, message },
    });
  }

  private hasRunningTurn(sessionId: SessionId): boolean {
    for (const turn of this.#turns.values()) {
      if (turn.sessionId === sessionId) return true;
    }
    return false;
  }

  private async waitForRunningTurns(sessionId: SessionId): Promise<void> {
    const pending = [...this.#turnPromises.values()]
      .filter((turn) => turn.sessionId === sessionId)
      .map((turn) => turn.promise);
    if (pending.length === 0) return;
    await Promise.allSettled(pending);
  }
}

function turnKey(sessionId: SessionId, turnId: TurnId): string {
  return JSON.stringify([sessionId, turnId]);
}

function transcriptEntry(
  sessionId: SessionId,
  turnId: TurnId,
  role: AiMessage["role"],
  content: AiContentBlock
): AiTranscriptEntry {
  return {
    sessionId,
    turnId,
    message: { role, content: [content] },
    usage: null,
  };
}
