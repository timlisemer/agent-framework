import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AiBackendMessage,
  AiSessionConfig,
  AiToolCall,
  AiTranscriptEntry,
  TokenUsage,
} from "../../src/ai-protocol/index.js";
import type { AiRunTurnInput } from "../../src/ai-backend/runtime-events.js";
import { isActiveToolStatus } from "../../src/ai-backend/timeline-status.js";
import {
  createAiBackendHarness as createHarness,
  defaultAiSessionConfig as defaultConfig,
  getSessionSnapshot,
  runtimeEvents as events,
  sendAiBackendInput as sendInput,
  startAiBackendSession as startSession,
  type EventFrame,
  waitForTurnFinished,
} from "../helpers/ai-backend-harness.js";
import {
  toolCallFixture,
  transcriptEntryFixture,
} from "../helpers/ai-backend-fixtures.js";

const provider = vi.hoisted(() => ({
  createResolvedProviderRunner: vi.fn(),
  createResumeProviderRunner: vi.fn(),
  runTurn: vi.fn(),
  ResumeProviderMismatchError: class ResumeProviderMismatchError extends Error {},
}));

function resolvedProviderFor(config: AiSessionConfig) {
  if (config.model === "invalid-model") throw new Error("Invalid model tier");
  return {
    type: "openrouter",
    mode: "sdk",
    modelId: "google/gemini-3.5-flash",
    sdkRuntime: "codex",
    costTracking: "none",
  } as const;
}

vi.mock("../../src/ai-backend/provider.js", async () => {
  const { createDefaultProviderMetadata } =
    await vi.importActual<typeof import("../../src/ai-backend/provider-metadata.js")>(
      "../../src/ai-backend/provider-metadata.js"
    );
  return {
    createResolvedProviderRunner: provider.createResolvedProviderRunner,
    createResumeProviderRunner: provider.createResumeProviderRunner,
    providerMetadataForResolvedProvider: (resolvedProvider: ReturnType<typeof resolvedProviderFor>) =>
      createDefaultProviderMetadata({
        provider: resolvedProvider.type,
        runtime: resolvedProvider.sdkRuntime,
        model: resolvedProvider.modelId,
        displayModel: resolvedProvider.modelId,
        availableModels: [],
      }),
    resolveSessionProvider: resolvedProviderFor,
    ResumeProviderMismatchError: provider.ResumeProviderMismatchError,
  };
});

const TOKEN_USAGE: TokenUsage = {
  promptTokens: 1,
  cachedTokens: null,
  completionTokens: 2,
  reasoningTokens: null,
  totalTokens: 3,
};

describe("AI backend session manager", () => {
  beforeEach(() => {
    provider.createResolvedProviderRunner.mockReset();
    provider.createResumeProviderRunner.mockReset();
    provider.createResolvedProviderRunner.mockImplementation((resolvedProvider: ReturnType<typeof resolvedProviderFor>) => ({
      resolvedProvider,
      runTurn: provider.runTurn,
    }));
    provider.runTurn.mockReset();
    provider.runTurn.mockImplementation(() => events({ type: "turn.completed", usage: null }));
  });

  it("starts sessions without provider execution and includes snapshot provider metadata", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-start");

    expect(frames[0]).toMatchObject({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: "session-start",
        snapshot: {
          sessionId: "session-start",
          status: "idle",
          transcript: [],
          toolCalls: [],
          backendProcesses: [],
          provider: expect.objectContaining({
            provider: "openrouter",
            runtime: "codex",
            model: "google/gemini-3.5-flash",
          }),
          continuation: { enabled: false, available: false },
        },
      },
    });
    expect(provider.runTurn).not.toHaveBeenCalled();
  });

  it("returns protocol errors for invalid internally resolved sessions", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-invalid", {
      ...defaultConfig,
      model: "invalid-model",
    });

    expect(frames[0]).toMatchObject({
      type: "response",
      response: {
        type: "error",
        sessionId: "session-invalid",
        error: { code: "runtime_error" },
      },
    });
  });

  it("uses transcript snapshots as the only source for visible timeline rows", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "user-1",
              sequenceId: 1,
              turnId: "turn-1",
              role: "user",
              text: "hello",
              metadata: { agentFrameworkSourceLine: 9 },
              createdAt: "2026-05-22T00:00:00.000Z",
              updatedAt: "2026-05-22T00:00:00.000Z",
              completedAt: "2026-05-22T00:00:00.000Z",
            }),
            transcriptEntryFixture({
              id: "assistant-1",
              sequenceId: 2,
              turnId: "turn-1",
              text: "draft",
              metadata: { agentFrameworkSourceLine: 10 },
              createdAt: "2026-05-22T00:00:00.000Z",
              updatedAt: "2026-05-22T00:00:00.000Z",
              completedAt: "2026-05-22T00:00:00.000Z",
            }),
          ],
          toolCalls: [],
          provider: { nativeSessionId: "native-session-1" },
        },
        {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "user-1",
              sequenceId: 1,
              turnId: "turn-1",
              role: "user",
              text: "hello",
              metadata: { agentFrameworkSourceLine: 9 },
              createdAt: "2026-05-22T00:00:00.000Z",
              updatedAt: "2026-05-22T00:00:00.000Z",
              completedAt: "2026-05-22T00:00:00.000Z",
            }),
            transcriptEntryFixture({
              id: "assistant-1",
              sequenceId: 2,
              turnId: "turn-1",
              text: "final",
              metadata: { agentFrameworkSourceLine: 11, provider: "codex" },
              createdAt: "2026-05-22T00:00:00.000Z",
              updatedAt: "2026-05-22T00:00:01.000Z",
              completedAt: "2026-05-22T00:00:01.000Z",
            }),
          ],
          toolCalls: [
            toolCallFixture({
              id: "tool-1",
              sequenceId: 3,
              turnId: "turn-1",
              name: "Read",
              inputText: "Read(file_path=\"src/example.ts\")",
              output: [{ type: "text", text: "file contents" }],
            }),
          ],
          provider: {
            context: { usedTokens: 10, maxTokens: 100, remainingTokens: 90 },
          },
        },
        { type: "turn.completed", usage: TOKEN_USAGE }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-transcript-source");
    await sendInput(manager, "session-transcript-source", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    const emitted = eventFrames(frames);
    expect(emitted.map((frame) => frame.event.seq)).toEqual(emitted.map((_, index) => index + 1));
    expect(emitted.map((frame) => frame.snapshot.lastEventSeq)).toEqual(emitted.map((frame) => frame.event.seq));
    for (const frame of emitted) {
      if (frame.event.type !== "sessionUpdated") continue;
      expect(frame.event.snapshot.lastEventSeq).toBe(frame.event.seq);
      expect(frame.event.snapshot.revision).toBe(frame.snapshot.revision);
      expect(frame.event.snapshot.transcript).toEqual(frame.snapshot.transcript);
      expect(frame.event.snapshot.toolCalls).toEqual(frame.snapshot.toolCalls);
    }
    expect(emitted.map((frame) => frame.event.type)).toEqual([
      "turnStarted",
      "sessionStatusChanged",
      "sessionUpdated",
      "sessionUpdated",
      "sessionStatusChanged",
      "turnFinished",
    ]);
    expect(emitted.some((frame) => [
      "messageCreated",
      "messageDelta",
      "messageCompleted",
      "toolCallCreated",
      "toolCallStatusChanged",
    ].includes(frame.event.type))).toBe(false);

    const snapshot = await getSessionSnapshot(manager, frames, "session-transcript-source");
    expect(snapshot.status).toBe("idle");
    expect(snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "user-1",
        sequenceId: 1,
        content: [{ type: "text", text: "hello" }],
        metadata: { agentFrameworkSourceLine: 9 },
      }),
      expect.objectContaining({
        id: "assistant-1",
        sequenceId: 2,
        content: [{ type: "text", text: "final" }],
        metadata: { agentFrameworkSourceLine: 11, provider: "codex" },
      }),
    ]);
    expect(snapshot.toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-1",
        sequenceId: 3,
        status: "completed",
        output: [{ type: "text", text: "file contents" }],
      }),
    ]);
    expect(snapshot.provider).toMatchObject({
      nativeSessionId: "native-session-1",
      usage: TOKEN_USAGE,
      context: { usedTokens: 10, maxTokens: 100, remainingTokens: 90 },
    });
  });

  it("echoes pending user input until a real transcript user row confirms it", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "synthetic-1",
              sequenceId: 1,
              turnId: "turn-synthetic",
              role: "user",
              text: "# AGENTS.md instructions for /tmp/project",
              metadata: {
                agentFrameworkMessageKind: "synthetic",
                agentFrameworkSyntheticSource: "provider-instructions",
              },
            }),
          ],
          toolCalls: [],
        },
        {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "synthetic-1",
              sequenceId: 1,
              turnId: "turn-synthetic",
              role: "user",
              text: "# AGENTS.md instructions for /tmp/project",
              metadata: {
                agentFrameworkMessageKind: "synthetic",
                agentFrameworkSyntheticSource: "provider-instructions",
              },
            }),
            transcriptEntryFixture({
              id: "user-1",
              sequenceId: 2,
              turnId: "turn-transcript",
              role: "user",
              text: "hello",
            }),
          ],
          toolCalls: [],
        },
        { type: "turn.completed", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-pending-user");
    await sendInput(manager, "session-pending-user", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    const emitted = eventFrames(frames);
    expect(emitted.find((frame) => frame.event.type === "turnStarted")?.snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "message-pending-turn-1",
        role: "user",
        status: "pending",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    const updates = emitted.filter((frame) => frame.event.type === "sessionUpdated");
    expect(updates[0]?.snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "synthetic-1",
        status: "completed",
        metadata: expect.objectContaining({ agentFrameworkMessageKind: "synthetic" }),
      }),
      expect.objectContaining({
        id: "message-pending-turn-1",
        status: "pending",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    expect(updates[1]?.snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "synthetic-1",
        status: "completed",
      }),
      expect.objectContaining({
        id: "user-1",
        status: "completed",
        content: [{ type: "text", text: "hello" }],
      }),
    ]);
    const snapshot = await getSessionSnapshot(manager, frames, "session-pending-user");
    expect(snapshot.transcript.some((entry) => entry.status === "pending")).toBe(false);
  });

  it("finalizes pending user input when a successful turn emits no transcript snapshot", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-no-transcript-success");
    await sendInput(manager, "session-no-transcript-success", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    const snapshot = await getSessionSnapshot(manager, frames, "session-no-transcript-success");
    expect(snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "message-pending-turn-1",
        turnId: "turn-1",
        role: "user",
        status: "completed",
        content: [{ type: "text", text: "hello" }],
        completedAt: expect.any(String),
      }),
    ]);
    expect(snapshot.transcript.some((entry) => entry.status === "pending")).toBe(false);
  });

  it("applies provider metadata and continuation control events", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "provider.metadata",
          provider: {
            nativeSessionId: "native-session-2",
            availableModels: [{ tier: "pro", id: "model-pro", displayName: "Model Pro" }],
            compaction: {
              lastCompactedAt: "2026-05-22T00:00:00.000Z",
              events: [{ reason: "context_limit" }],
            },
          },
        },
        { type: "continuation.updated", available: true },
        { type: "turn.completed", usage: TOKEN_USAGE }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-provider-control", { ...defaultConfig, continuable: true });
    await sendInput(manager, "session-provider-control", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "sessionUpdated" }),
    }));
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "continuationUpdated",
        continuation: expect.objectContaining({ available: true }),
      }),
    }));
    const snapshot = await getSessionSnapshot(manager, frames, "session-provider-control");
    expect(snapshot.provider).toMatchObject({
      nativeSessionId: "native-session-2",
      availableModels: [{ tier: "pro", id: "model-pro", displayName: "Model Pro" }],
      compaction: {
        lastCompactedAt: "2026-05-22T00:00:00.000Z",
        events: [{ reason: "context_limit" }],
      },
      usage: TOKEN_USAGE,
    });
    expect(snapshot.continuation).toMatchObject({ enabled: true, available: true });
  });

  it("applies provider plan updates without downgrading approved plans", async () => {
    provider.runTurn.mockImplementation(() =>
      events({ type: "plan.updated", state: { mode: "planning", planText: "Provider plan", approved: false } })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-plan");
    await sendInput(manager, "session-plan", "turn-1", "plan");
    await waitForTurnFinished(frames, "turn-1");
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "planStateChanged",
        state: { mode: "planning", planText: "Provider plan", approved: false },
      }),
    }));

    await manager.handle({
      type: "request",
      request: {
        type: "setPlanState",
        sessionId: "session-plan",
        state: { mode: "approved", planText: "Approved plan", approved: true },
      },
    });
    provider.runTurn.mockImplementation(() =>
      events({ type: "plan.updated", state: { mode: "planning", planText: "Updated provider plan", approved: false } })
    );
    await sendInput(manager, "session-plan", "turn-2", "plan again");
    await waitForTurnFinished(frames, "turn-2");

    const snapshot = await getSessionSnapshot(manager, frames, "session-plan");
    expect(snapshot.plan).toEqual({ mode: "approved", planText: "Updated provider plan", approved: true });
  });

  it("returns reconnect snapshots and events since a cursor", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-reconnect");
    await sendInput(manager, "session-reconnect", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");
    await manager.handle({
      type: "request",
      request: { type: "getSessionSnapshot", sessionId: "session-reconnect" },
    });
    await manager.handle({
      type: "request",
      request: { type: "eventsSince", sessionId: "session-reconnect", afterSeq: 1 },
    });

    const response = frames.at(-1);
    expect(frames.at(-2)).toMatchObject({
      type: "response",
      response: { type: "sessionSnapshot", sessionId: "session-reconnect" },
    });
    expect(response).toMatchObject({
      type: "response",
      response: { type: "sessionEvents", sessionId: "session-reconnect" },
    });
    if (response?.type !== "response" || response.response.type !== "sessionEvents") {
      throw new Error("expected sessionEvents response");
    }
    expect(response.response.events.every((event) => event.seq > 1)).toBe(true);
    expect(response.response.snapshot.lastEventSeq).toBeGreaterThan(1);
  });

  it("keeps streamed provider failures in the session snapshot without leaking native details", async () => {
    provider.runTurn.mockImplementation(() =>
      events({ type: "error", error: new Error("native provider detail") })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-stream-failure");
    await sendInput(manager, "session-stream-failure", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    const snapshot = await getSessionSnapshot(manager, frames, "session-stream-failure");
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toMatchObject({
      code: "runtime_error",
      message: "Runtime operation failed",
    });
    expect(snapshot.provider.errors).toContainEqual(expect.objectContaining({
      code: "runtime_error",
      message: "Runtime operation failed",
    }));
    expect(JSON.stringify(frames)).not.toContain("native provider detail");
  });

  it("sanitizes thrown provider failures", async () => {
    provider.runTurn.mockImplementation(async function* () {
      throw new Error("native thrown detail");
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-thrown-failure");
    await sendInput(manager, "session-thrown-failure", "turn-1", "hello");
    await waitForTurnFinished(frames, "turn-1");

    const snapshot = await getSessionSnapshot(manager, frames, "session-thrown-failure");
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toMatchObject({ code: "runtime_error", message: "Runtime operation failed" });
    expect(JSON.stringify(frames)).not.toContain("native thrown detail");
  });

  it("reuses one provider runner across turns in a session", async () => {
    const transcript: AiTranscriptEntry[] = [];
    provider.runTurn.mockImplementation(async function* (input: AiRunTurnInput) {
      transcript.push(transcriptEntryFixture({
        id: `user-${input.turnId}`,
        sequenceId: transcript.length + 1,
        turnId: input.turnId,
        role: "user",
        text: input.prompt,
      }));
      transcript.push(transcriptEntryFixture({
        id: `assistant-${input.turnId}`,
        sequenceId: transcript.length + 1,
        turnId: input.turnId,
        text: `reply:${input.prompt}`,
      }));
      yield { type: "timeline.snapshot", transcript: [...transcript], toolCalls: [] };
      yield { type: "turn.completed", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-runner-reuse", { ...defaultConfig, continuable: true });
    await sendInput(manager, "session-runner-reuse", "turn-1", "first");
    await waitForTurnFinished(frames, "turn-1");
    await sendInput(manager, "session-runner-reuse", "turn-2", "second");
    await waitForTurnFinished(frames, "turn-2");

    expect(provider.createResolvedProviderRunner).toHaveBeenCalledTimes(1);
    expect(provider.runTurn).toHaveBeenCalledTimes(2);
    const snapshot = await getSessionSnapshot(manager, frames, "session-runner-reuse");
    expect(snapshot.transcript.map((entry) => entry.content)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "reply:first" }],
      [{ type: "text", text: "second" }],
      [{ type: "text", text: "reply:second" }],
    ]);
  });

  it("rejects overlapping turns and session replacement for the same session", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.runTurn.mockImplementation(async function* () {
      await pending;
      yield { type: "turn.completed", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-overlap", { ...defaultConfig, continuable: true });
    await sendInput(manager, "session-overlap", "turn-1", "first");
    await sendInput(manager, "session-overlap", "turn-2", "second");
    await startSession(manager, "session-overlap", { ...defaultConfig, systemPrompt: "replacement" });

    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "error",
        sessionId: "session-overlap",
        turnId: "turn-2",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    }));
    expect(frames).toContainEqual({
      type: "response",
      response: expect.objectContaining({
        type: "error",
        sessionId: "session-overlap",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    });

    release();
    await waitForTurnFinished(frames, "turn-1");
  });

  it("does not reject turns for sessions whose ids are prefixes of running sessions", async () => {
    const releases: Array<() => void> = [];
    provider.runTurn.mockImplementation(async function* () {
      await new Promise<void>((resolve) => releases.push(resolve));
      yield { type: "turn.completed", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session");
    await startSession(manager, "session:child");
    await sendInput(manager, "session:child", "turn-1", "child");
    await sendInput(manager, "session", "turn-1", "parent");

    expect(provider.runTurn).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await vi.waitFor(() => {
      expect(eventFrames(frames).filter((frame) => frame.event.type === "turnFinished")).toHaveLength(2);
    });
  });

  it("reports close disposal failures and does not leave the session closing", async () => {
    provider.createResolvedProviderRunner.mockImplementationOnce((resolvedProvider: ReturnType<typeof resolvedProviderFor>) => ({
      resolvedProvider,
      runTurn: provider.runTurn,
      dispose: () => {
        throw new Error("dispose failed");
      },
    }));
    const { frames, manager } = createHarness();

    await startSession(manager, "session-close-failure");
    await manager.handle({
      type: "request",
      request: { type: "closeSession", requestId: "close-failure", sessionId: "session-close-failure" },
    });
    await sendInput(manager, "session-close-failure", "turn-after-close", "hello");

    expect(frames).toContainEqual({
      type: "response",
      response: {
        type: "requestError",
        requestId: "close-failure",
        sessionId: "session-close-failure",
        code: "runtime_error",
        message: "Runtime operation failed",
        recoverable: false,
      },
    });
    expect(frames).toContainEqual({
      type: "response",
      response: expect.objectContaining({
        type: "error",
        sessionId: "session-close-failure",
        error: expect.objectContaining({ code: "not_found" }),
      }),
    });
    expect(JSON.stringify(frames)).not.toContain("AI session is closing");
  });

  it("returns a conflict response for input while close is in progress", async () => {
    let releaseDispose!: () => void;
    let markDisposeStarted!: () => void;
    const disposeStarted = new Promise<void>((resolve) => {
      markDisposeStarted = resolve;
    });
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve;
    });
    provider.createResolvedProviderRunner.mockImplementationOnce((resolvedProvider: ReturnType<typeof resolvedProviderFor>) => ({
      resolvedProvider,
      runTurn: provider.runTurn,
      dispose: () => {
        markDisposeStarted();
        return disposeBlocked;
      },
    }));
    const { frames, manager } = createHarness();

    await startSession(manager, "session-closing");
    const closePromise = manager.handle({
      type: "request",
      request: { type: "closeSession", requestId: "close-in-progress", sessionId: "session-closing" },
    });
    await disposeStarted;
    await sendInput(manager, "session-closing", "turn-during-close", "hello");
    await startSession(manager, "session-closing");
    await manager.handle({
      type: "request",
      request: {
        type: "resumeSession",
        requestId: "resume-during-close",
        sessionId: "session-closing",
        resumeId: "stale",
        config: {
          ...defaultConfig,
          continuable: true,
          sdkRuntimeEnvironment: "user",
          sdkRuntimeHome: "managedAstral",
        },
      },
    });

    expect(frames.filter((frame) =>
      frame.type === "response" &&
      frame.response.type === "error" &&
      frame.response.sessionId === "session-closing" &&
      frame.response.error.code === "conflict"
    )).toHaveLength(2);
    expect(frames).toContainEqual({
      type: "response",
      response: {
        type: "requestError",
        requestId: "resume-during-close",
        sessionId: "session-closing",
        code: "conflict",
        message: "AI session is closing: session-closing",
        recoverable: false,
      },
    });

    releaseDispose();
    await closePromise;
    expect(frames).toContainEqual({
      type: "response",
      response: { type: "sessionClosed", requestId: "close-in-progress", sessionId: "session-closing" },
    });
  });

  it("closes without waiting for a non-cooperative aborted turn", async () => {
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    provider.runTurn.mockImplementation(async function* () {
      markTurnStarted();
      await new Promise<never>(() => undefined);
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-non-cooperative-close");
    await sendInput(manager, "session-non-cooperative-close", "turn-1", "wait");
    await turnStarted;
    await manager.handle({
      type: "request",
      request: {
        type: "closeSession",
        requestId: "close-non-cooperative",
        sessionId: "session-non-cooperative-close",
      },
    });

    expect(frames).toContainEqual({
      type: "response",
      response: {
        type: "sessionClosed",
        requestId: "close-non-cooperative",
        sessionId: "session-non-cooperative-close",
      },
    });
  });

  it("ignores stale turn events after close and same-id restart", async () => {
    let markOldTurnStarted!: () => void;
    let releaseOldTurn!: () => void;
    let markOldTurnClosed!: () => void;
    let releaseNewTurn!: () => void;
    let markNewTurnStarted!: () => void;
    const oldTurnStarted = new Promise<void>((resolve) => {
      markOldTurnStarted = resolve;
    });
    const oldTurnRelease = new Promise<void>((resolve) => {
      releaseOldTurn = resolve;
    });
    const oldTurnClosed = new Promise<void>((resolve) => {
      markOldTurnClosed = resolve;
    });
    const newTurnStarted = new Promise<void>((resolve) => {
      markNewTurnStarted = resolve;
    });
    provider.runTurn.mockImplementationOnce(async function* () {
      try {
        yield {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "old-entry",
              sequenceId: 1,
              turnId: "old-turn",
              role: "assistant",
              text: "old-start",
            }),
          ],
          toolCalls: [],
        };
        markOldTurnStarted();
        await oldTurnRelease;
        yield {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "old-entry",
              sequenceId: 1,
              turnId: "old-turn",
              role: "assistant",
              text: "old-finish",
            }),
          ],
          toolCalls: [],
        };
      } finally {
        markOldTurnClosed();
      }
    });
    provider.runTurn.mockImplementationOnce(async function* () {
      markNewTurnStarted();
      yield {
        type: "timeline.snapshot",
        transcript: [
          transcriptEntryFixture({
            id: "new-entry",
            sequenceId: 1,
            turnId: "new-turn",
            role: "user",
            text: "new",
          }),
        ],
        toolCalls: [],
      };
      await new Promise<void>((resolve) => {
        releaseNewTurn = resolve;
      });
      yield {
        type: "timeline.snapshot",
        transcript: [
          transcriptEntryFixture({
            id: "new-entry",
            sequenceId: 1,
            turnId: "new-turn",
            role: "user",
            text: "new",
          }),
          transcriptEntryFixture({
            id: "new-finish-entry",
            sequenceId: 2,
            turnId: "new-turn",
            role: "assistant",
            text: "new-finish",
          }),
        ],
        toolCalls: [],
      };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-reused");
    await sendInput(manager, "session-reused", "old-turn", "old");
    await oldTurnStarted;
    await manager.handle({
      type: "request",
      request: { type: "closeSession", requestId: "close-reused", sessionId: "session-reused" },
    });
    await startSession(manager, "session-reused");
    await sendInput(manager, "session-reused", "new-turn", "new");
    await newTurnStarted;

    releaseOldTurn();
    await oldTurnClosed;
    await sendInput(manager, "session-reused", "overlap", "overlap");
    const runningSnapshot = await getSessionSnapshot(manager, frames, "session-reused");

    expect(JSON.stringify(frames)).not.toContain("old-finish");
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({
        type: "error",
        sessionId: "session-reused",
        turnId: "overlap",
        message: "AI session already has a running turn: session-reused",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    }));
    expect(runningSnapshot.status).toBe("running");
    expect(runningSnapshot.transcript).toEqual([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "new" }] }),
    ]);

    releaseNewTurn();
    await waitForTurnFinished(frames, "new-turn");
  });

  it("reports resume running-turn conflicts as non-recoverable request errors", async () => {
    let release!: () => void;
    provider.runTurn.mockImplementation(async function* () {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield { type: "turn.completed", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-resume-conflict");
    await sendInput(manager, "session-resume-conflict", "turn-1", "wait");
    await manager.handle({
      type: "request",
      request: {
        type: "resumeSession",
        requestId: "resume-running",
        sessionId: "session-resume-conflict",
        resumeId: "stale",
        config: {
          ...defaultConfig,
          continuable: true,
          sdkRuntimeEnvironment: "user",
          sdkRuntimeHome: "managedAstral",
        },
      },
    });

    expect(frames).toContainEqual({
      type: "response",
      response: {
        type: "requestError",
        requestId: "resume-running",
        sessionId: "session-resume-conflict",
        code: "conflict",
        message: "AI session has a running turn: session-resume-conflict",
        recoverable: false,
      },
    });

    release();
    await waitForTurnFinished(frames, "turn-1");
  });

  it("emits protocol errors for unknown sessions", async () => {
    const { frames, manager } = createHarness();

    await sendInput(manager, "missing-session", "turn-missing", "hello");
    await manager.handle({
      type: "request",
      request: { type: "getSessionSnapshot", sessionId: "missing-session" },
    });

    expect(frames).toMatchObject([
      { type: "response", response: { type: "error", sessionId: "missing-session", error: { code: "not_found" } } },
      { type: "response", response: { type: "error", sessionId: "missing-session", error: { code: "not_found" } } },
    ]);
  });

  it("cancels in-flight turns through the provider signal", async () => {
    let providerSawAbort = false;
    let markTurnStarted!: () => void;
    const turnStarted = new Promise<void>((resolve) => {
      markTurnStarted = resolve;
    });
    provider.runTurn.mockImplementation(async function* (input: AiRunTurnInput) {
      markTurnStarted();
      yield {
        type: "timeline.snapshot",
        transcript: [],
        toolCalls: [
          toolCallFixture({
            id: "mcp-tool-cancel",
            sequenceId: 2,
            turnId: input.turnId,
            name: "mcp__agent_framework__check",
            inputText: "mcp__agent_framework__check",
            status: "running",
            result: null,
            progress: "Running",
            completedAt: null,
          }),
        ],
      };
      await new Promise<void>((resolve) => {
        input.signal.addEventListener("abort", () => {
          providerSawAbort = true;
          resolve();
        }, { once: true });
      });
      input.signal.throwIfAborted();
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-cancel");
    await sendInput(manager, "session-cancel", "turn-cancel", "wait");
    await turnStarted;
    await waitForToolStatus(frames, "mcp-tool-cancel", "running");
    await manager.handle({ type: "cancel", sessionId: "session-cancel", turnId: "turn-cancel" });
    await waitForTurnFinished(frames, "turn-cancel");

    expect(providerSawAbort).toBe(true);
    const snapshot = await getSessionSnapshot(manager, frames, "session-cancel");
    expect(snapshot.status).toBe("cancelled");
    expect(snapshot.transcript).toEqual([
      expect.objectContaining({
        id: "message-pending-turn-cancel",
        turnId: "turn-cancel",
        role: "user",
        status: "cancelled",
        content: [{ type: "text", text: "wait" }],
        completedAt: expect.any(String),
      }),
      expect.objectContaining({
        id: "message-terminal-turn-cancel-cancelled",
        turnId: "turn-cancel",
        role: "assistant",
        status: "cancelled",
        content: [{
          type: "error",
          message: "cancelled: Operation cancelled (recoverable)",
        }],
        completedAt: expect.any(String),
      }),
    ]);
    expect(snapshot.transcript.map((entry) => entry.sequenceId)).toEqual([1, 3]);
    expect(snapshot.transcript.some((entry) => entry.status === "pending" || entry.status === "streaming")).toBe(false);
    expect(snapshot.toolCalls).toEqual([
      expect.objectContaining({
        id: "mcp-tool-cancel",
        turnId: "turn-cancel",
        status: "cancelled",
        wait: null,
        progress: null,
        result: { state: "cancelled", output: [], error: null },
        completedAt: expect.any(String),
      }),
    ]);
    expect(snapshot.toolCalls.some((tool) => isActiveToolStatus(tool.status))).toBe(false);
  });

  it("records a distinct sequenced terminal transcript entry for each interrupted turn", async () => {
    const startedTurns: string[] = [];
    provider.runTurn.mockImplementation(async function* (input: AiRunTurnInput) {
      startedTurns.push(input.turnId);
      await new Promise<void>((resolve) => {
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      input.signal.throwIfAborted();
    });
    const { frames, manager } = createHarness();
    const turnIds = ["turn-cancel-1", "turn-cancel-2", "turn-cancel-3"];

    await startSession(manager, "session-repeat-cancel");
    for (const turnId of turnIds) {
      await sendInput(manager, "session-repeat-cancel", turnId, `wait ${turnId}`);
      await vi.waitFor(() => expect(startedTurns).toContain(turnId));
      await manager.handle({ type: "cancel", sessionId: "session-repeat-cancel", turnId });
      await waitForTurnFinished(frames, turnId);
    }

    const snapshot = await getSessionSnapshot(manager, frames, "session-repeat-cancel");
    const terminalEntries = snapshot.transcript.filter((entry) =>
      entry.id.startsWith("message-terminal-")
    );
    expect(terminalEntries).toHaveLength(3);
    expect(new Set(terminalEntries.map((entry) => entry.id)).size).toBe(3);
    expect(new Set(terminalEntries.map((entry) => entry.sequenceId)).size).toBe(3);
    expect(terminalEntries).toEqual(turnIds.map((turnId) =>
      expect.objectContaining({
        id: `message-terminal-${turnId}-cancelled`,
        turnId,
        status: "cancelled",
        content: [{
          type: "error",
          message: "cancelled: Operation cancelled (recoverable)",
        }],
      })
    ));
    for (const turnId of turnIds) {
      expect(snapshot.transcript).toContainEqual(expect.objectContaining({
        id: `message-pending-${turnId}`,
        turnId,
        role: "user",
        status: "cancelled",
      }));
    }
    expect(snapshot.transcript.some((entry) => entry.status === "pending" || entry.status === "streaming")).toBe(false);
  });

  it("submits native transcript tool ids directly to providers", async () => {
    const submitToolDecision = vi.fn();
    provider.createResolvedProviderRunner.mockImplementation((resolvedProvider: ReturnType<typeof resolvedProviderFor>) => ({
      resolvedProvider,
      runTurn: provider.runTurn,
      submitToolDecision,
    }));
    provider.runTurn.mockImplementation(() =>
      events({
        type: "timeline.snapshot",
        transcript: [],
        toolCalls: [waitingTool("native-tool-1")],
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-decision");
    await sendInput(manager, "session-decision", "turn-1", "run");
    await waitForWaitingTool(frames, "native-tool-1");
    await manager.handle({
      type: "request",
      request: {
        type: "submitToolDecision",
        sessionId: "session-decision",
        turnId: "turn-1",
        decision: { toolCallId: "native-tool-1", decision: "approve", reason: null },
      },
    });

    expect(submitToolDecision).toHaveBeenCalledWith({ toolCallId: "native-tool-1", decision: "approve", reason: null });
    expect(frames).toContainEqual({
      type: "response",
      response: { type: "accepted", sessionId: "session-decision", turnId: "turn-1" },
    });
  });

  it("rejects unsupported manual tool approval without mutating the transcript tool", async () => {
    provider.runTurn.mockImplementation(() =>
      events({
        type: "timeline.snapshot",
        transcript: [],
        toolCalls: [waitingTool("native-tool-1")],
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-unsupported-decision");
    await sendInput(manager, "session-unsupported-decision", "turn-1", "run");
    await waitForWaitingTool(frames, "native-tool-1");
    await manager.handle({
      type: "request",
      request: {
        type: "submitToolDecision",
        sessionId: "session-unsupported-decision",
        turnId: "turn-1",
        decision: { toolCallId: "native-tool-1", decision: "approve", reason: null },
      },
    });

    expect(frames).toContainEqual(expect.objectContaining({
      type: "response",
      response: expect.objectContaining({
        type: "error",
        sessionId: "session-unsupported-decision",
        error: expect.objectContaining({ code: "runtime_error" }),
      }),
    }));
    const snapshot = await getSessionSnapshot(manager, frames, "session-unsupported-decision");
    expect(snapshot.toolCalls).toEqual([
      expect.objectContaining({
        id: "native-tool-1",
        status: "waiting",
        result: null,
      }),
    ]);
  });

  it("rejects tool decisions for tools that are not waiting", async () => {
    provider.runTurn.mockImplementation(() =>
      events({
        type: "timeline.snapshot",
        transcript: [],
        toolCalls: [
          toolCallFixture({
            id: "native-tool-1",
            sequenceId: 1,
            turnId: "turn-1",
            status: "completed",
          }),
        ],
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-nonwaiting-decision");
    await sendInput(manager, "session-nonwaiting-decision", "turn-1", "run");
    await waitForTurnFinished(frames, "turn-1");
    await manager.handle({
      type: "request",
      request: {
        type: "submitToolDecision",
        sessionId: "session-nonwaiting-decision",
        turnId: "turn-1",
        decision: { toolCallId: "native-tool-1", decision: "approve", reason: null },
      },
    });

    expect(frames.at(-1)).toMatchObject({
      type: "response",
      response: {
        type: "error",
        sessionId: "session-nonwaiting-decision",
        error: { code: "invalid_request" },
      },
    });
  });

  it("does not import legacy provider runners from the UI backend", () => {
    const files = [
      "src/ai-backend/server.ts",
      "src/ai-backend/session-manager.ts",
      "src/ai-backend/provider.ts",
    ];
    const combined = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(combined).not.toContain("runProviderSdk");
    expect(combined).not.toContain("runClaudeAgent");
    expect(combined).not.toContain("runCodexAgent");
  });
});

async function waitForWaitingTool(frames: AiBackendMessage[], toolCallId: string): Promise<void> {
  await waitForToolStatus(frames, toolCallId, "waiting");
}

async function waitForToolStatus(
  frames: AiBackendMessage[],
  toolCallId: string,
  status: AiToolCall["status"]
): Promise<void> {
  await vi.waitFor(() => {
    expect(frames.some((frame) =>
      frame.type === "event" &&
      frame.event.type === "sessionUpdated" &&
      frame.snapshot.toolCalls.some((tool) => tool.id === toolCallId && tool.status === status)
    )).toBe(true);
  });
}

function waitingTool(id: string): AiToolCall {
  return toolCallFixture({
    id,
    sequenceId: 1,
    turnId: "turn-1",
    status: "waiting",
    wait: { reason: "approval", since: "2026-05-22T00:00:00.000Z" },
    result: null,
    completedAt: null,
  });
}

function eventFrames(frames: AiBackendMessage[]): EventFrame[] {
  return frames.filter((frame): frame is EventFrame => frame.type === "event");
}
