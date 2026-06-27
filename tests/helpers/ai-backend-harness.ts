import { expect, vi } from "vitest";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiRuntimeEvent } from "../../src/ai-backend/runtime-events.js";
import type {
  AiBackendMessage,
  AiRequest,
  AiSessionConfig,
  AiSessionSnapshot,
  SessionId,
} from "../../src/ai-protocol/index.js";

export type SessionStartedFrame = Extract<AiBackendMessage, { type: "response" }> & {
  response: Extract<Extract<AiBackendMessage, { type: "response" }>["response"], { type: "sessionStarted" }>;
};

export type SessionSnapshotFrame = Extract<AiBackendMessage, { type: "response" }> & {
  response: Extract<Extract<AiBackendMessage, { type: "response" }>["response"], { type: "sessionSnapshot" }>;
};

export type EventFrame = Extract<AiBackendMessage, { type: "event" }>;
export type EventOf<T extends EventFrame["event"]["type"]> = Extract<EventFrame["event"], { type: T }>;
export type TypedEventFrame<T extends EventFrame["event"]["type"]> = EventFrame & { event: EventOf<T> };
export type AiBackendHarness = { frames: AiBackendMessage[]; manager: AiBackendSessionManager };

export const defaultAiSessionConfig: AiSessionConfig = {
  model: null,
  workingDir: null,
  systemPrompt: null,
  continuable: false,
  sdkRuntimeEnvironment: "isolated",
};

export function createAiBackendHarness(): AiBackendHarness {
  const frames: AiBackendMessage[] = [];
  return { frames, manager: new AiBackendSessionManager((frame) => frames.push(frame)) };
}

export async function startAiBackendSession(
  manager: AiBackendSessionManager,
  sessionId: SessionId,
  config: AiSessionConfig = defaultAiSessionConfig
): Promise<void> {
  await manager.handle({
    type: "request",
    request: { type: "startSession", sessionId, config },
  });
}

export async function sendAiBackendInput(
  manager: { handle(frame: { type: "request"; request: Extract<AiRequest, { type: "sendInput" }> }): Promise<void> },
  sessionId: string,
  turnId: string,
  input: string
): Promise<void> {
  await manager.handle({
    type: "request",
    request: { type: "sendInput", sessionId, turnId, input },
  });
}

export async function waitForTurnFinished(frames: AiBackendMessage[], turnId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(frames.some((frame) =>
      frame.type === "event" &&
      frame.event.type === "turnFinished" &&
      frame.event.turnId === turnId
    )).toBe(true);
  });
}

export async function* runtimeEvents(...items: AiRuntimeEvent[]): AsyncIterable<AiRuntimeEvent> {
  yield* items;
}

export async function getSessionSnapshot(
  manager: AiBackendSessionManager,
  frames: AiBackendMessage[],
  sessionId: SessionId
): Promise<AiSessionSnapshot> {
  const start = frames.length;
  await manager.handle({
    type: "request",
    request: { type: "getSessionSnapshot", sessionId },
  });
  const response = frames.slice(start).find((frame): frame is SessionSnapshotFrame =>
    isSessionSnapshotFrame(frame, sessionId)
  );
  if (!response) {
    throw new Error(`expected sessionSnapshot response for ${sessionId}`);
  }
  return response.response.snapshot;
}

export function requireSessionStartedFrame(frames: AiBackendMessage[], sessionId?: string): SessionStartedFrame {
  const started = frames.find((frame): frame is SessionStartedFrame =>
    frame.type === "response" &&
    frame.response.type === "sessionStarted" &&
    (sessionId === undefined || frame.response.sessionId === sessionId)
  );
  if (!started) throw new Error("expected sessionStarted response");
  return started;
}

export function isSessionSnapshotFrame(frame: AiBackendMessage, sessionId: SessionId): frame is SessionSnapshotFrame {
  return frame.type === "response" && frame.response.type === "sessionSnapshot" && frame.response.sessionId === sessionId;
}

export function isEventFrame<T extends EventFrame["event"]["type"]>(
  frame: AiBackendMessage,
  type: T
): frame is TypedEventFrame<T> {
  return frame.type === "event" && frame.event.type === type;
}
