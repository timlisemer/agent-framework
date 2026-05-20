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
import { createProviderRunner, resolveSessionProvider } from "./provider.js";

type WriteFrame = (frame: AiBackendMessage) => void;

export class AiBackendSessionManager {
  readonly #store = new TranscriptStore();
  readonly #write: WriteFrame;
  readonly #turns = new Map<string, AbortController>();

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
        this.startSession(request.sessionId, request.config);
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

  private startSession(sessionId: SessionId, config: AiSessionConfig): void {
    let resolvedProvider: ReturnType<typeof resolveSessionProvider>;
    try {
      resolvedProvider = resolveSessionProvider(config);
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
    const controller = new AbortController();
    this.#turns.set(turnKey(sessionId, turnId), controller);
    this.#store.setStatus(sessionId, "running");
    this.#write({
      type: "response",
      response: { type: "accepted", sessionId, turnId },
    });
    this.#write({ type: "event", event: { type: "turnStarted", sessionId, turnId } });
    this.#store.append(sessionId, transcriptEntry(sessionId, turnId, "user", { type: "text", text: input }));
    void this.runTurn(sessionId, turnId, input, controller, baseConfig);
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
      const runner = createProviderRunner(config);
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
      this.#turns.delete(turnKey(sessionId, turnId));
    }
  }

  private cancel(sessionId: SessionId, turnId: TurnId | null): void {
    if (turnId) {
      this.#turns.get(turnKey(sessionId, turnId))?.abort();
    } else {
      for (const [key, controller] of this.#turns) {
        if (key.startsWith(`${sessionId}:`)) controller.abort();
      }
    }
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
}

function turnKey(sessionId: SessionId, turnId: TurnId): string {
  return `${sessionId}:${turnId}`;
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
