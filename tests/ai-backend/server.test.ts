import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage, AiSessionConfig, SessionId } from "../../src/ai-protocol/index.js";

const provider = vi.hoisted(() => ({
  createProviderRunner: vi.fn(),
  runTurn: vi.fn(),
}));

vi.mock("../../src/ai-backend/provider.js", () => ({
  createProviderRunner: provider.createProviderRunner,
  resolveSessionProvider: (config: AiSessionConfig) => {
    if (config.provider === "invalid-provider") throw new Error("Invalid provider 'invalid-provider'");
    return {
      type: "openrouter",
      mode: "sdk",
      modelId: "anthropic/claude-opus-4.5",
      sdkRuntime: "codex",
      costTracking: "none",
    };
  },
}));

const defaultConfig: AiSessionConfig = {
  provider: "openrouter",
  model: null,
  workingDir: null,
  systemPrompt: null,
  continuable: false,
};

function createHarness(): { frames: AiBackendMessage[]; manager: AiBackendSessionManager } {
  const frames: AiBackendMessage[] = [];
  return { frames, manager: new AiBackendSessionManager((frame) => frames.push(frame)) };
}

async function startSession(
  manager: AiBackendSessionManager,
  sessionId: SessionId,
  config: AiSessionConfig = defaultConfig
): Promise<void> {
  await manager.handle({
    type: "request",
    request: {
      type: "startSession",
      sessionId,
      config,
    },
  });
}

describe("AI backend session manager", () => {
  beforeEach(() => {
    provider.createProviderRunner.mockReset();
    provider.createProviderRunner.mockImplementation(() => ({
      resolvedProvider: { type: "openrouter" },
      runTurn: provider.runTurn,
    }));
    provider.runTurn.mockReset();
  });

  it("starts sessions without provider execution", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-start-resume");
    const started = frames[0];
    expect(started.type).toBe("response");
    if (started.type !== "response" || started.response.type !== "sessionStarted") {
      throw new Error("expected sessionStarted response");
    }
    expect(started.response.snapshot.resume?.provider).toBe("openrouter");
    expect(started.response.sessionId).toBe("session-start-resume");
  });

  it("includes resolved default provider metadata in start snapshots", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-default-provider", {
      provider: null,
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
    });

    expect(frames[0]).toMatchObject({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: "session-default-provider",
        snapshot: {
          resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: null },
        },
      },
    });
  });

  it("returns protocol errors for invalid session providers", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-invalid-provider", {
      provider: "invalid-provider",
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
    });

    expect(frames[0]).toMatchObject({
      type: "response",
      response: {
        type: "error",
        sessionId: "session-invalid-provider",
        message: expect.stringContaining("Invalid provider"),
      },
    });
  });

  it("emits an idle session snapshot after a successful turn", async () => {
    provider.runTurn.mockResolvedValue({
      text: "done",
      usage: null,
      resume: {
        provider: "openrouter",
        nativeSessionId: "native-session",
        nativeThreadId: null,
      },
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-turn-success");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-turn-success",
        turnId: "turn-1",
        input: "hello",
      },
    });

    await vi.waitFor(() => {
      expect(
        frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")
      ).toBe(true);
    });
    const sessionUpdated = frames.find(
      (frame) => frame.type === "event" && frame.event.type === "sessionUpdated"
    );

    expect(sessionUpdated).toMatchObject({
      type: "event",
      event: {
        type: "sessionUpdated",
        sessionId: "session-turn-success",
        snapshot: {
          status: "idle",
          resume: { provider: "openrouter", nativeSessionId: "native-session" },
        },
      },
    });
    if (sessionUpdated?.type !== "event" || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    expect(sessionUpdated.event.snapshot.transcript).toHaveLength(2);
  });

  it("reuses one provider runner across turns in a session", async () => {
    provider.runTurn
      .mockResolvedValueOnce({
        text: "first",
        usage: null,
        resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: "thread-1" },
      })
      .mockResolvedValueOnce({
        text: "second",
        usage: null,
        resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: "thread-1" },
      });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-runner-reuse", { ...defaultConfig, continuable: true });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-runner-reuse",
        turnId: "turn-1",
        input: "first",
      },
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session-runner-reuse", turnId: "turn-1", usage: null },
      });
    });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-runner-reuse",
        turnId: "turn-2",
        input: "second",
      },
    });

    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session-runner-reuse", turnId: "turn-2", usage: null },
      });
    });
    expect(provider.createProviderRunner).toHaveBeenCalledTimes(1);
    expect(provider.runTurn).toHaveBeenCalledTimes(2);
  });

  it("rejects overlapping turns for the same session", async () => {
    let resolveTurn!: (value: unknown) => void;
    provider.runTurn.mockImplementation(
      () => new Promise((resolve) => {
        resolveTurn = resolve;
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-overlap", { ...defaultConfig, continuable: true });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-overlap",
        turnId: "turn-1",
        input: "first",
      },
    });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-overlap",
        turnId: "turn-2",
        input: "second",
      },
    });

    expect(frames).toContainEqual({
      type: "event",
      event: {
        type: "error",
        sessionId: "session-overlap",
        turnId: "turn-2",
        message: "AI session already has a running turn: session-overlap",
      },
    });
    expect(provider.runTurn).toHaveBeenCalledTimes(1);

    resolveTurn({
      text: "done",
      usage: null,
      resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: null },
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session-overlap", turnId: "turn-1", usage: null },
      });
    });
  });

  it("does not reject turns for sessions whose ids are prefixes of running sessions", async () => {
    const resolveTurns: Array<(value: unknown) => void> = [];
    provider.runTurn.mockImplementation(
      () => new Promise((resolve) => {
        resolveTurns.push(resolve);
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session");
    await startSession(manager, "session:child");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session:child",
        turnId: "turn-1",
        input: "child",
      },
    });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session",
        turnId: "turn-1",
        input: "parent",
      },
    });

    expect(provider.runTurn).toHaveBeenCalledTimes(2);
    expect(frames).not.toContainEqual({
      type: "event",
      event: {
        type: "error",
        sessionId: "session",
        turnId: "turn-1",
        message: "AI session already has a running turn: session",
      },
    });

    for (const resolveTurn of resolveTurns) {
      resolveTurn({
        text: "done",
        usage: null,
        resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: null },
      });
    }
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session", turnId: "turn-1", usage: null },
      });
    });
  });

  it("waits for an in-flight turn before replacing a session runner", async () => {
    let resolveTurn!: (value: unknown) => void;
    const firstRunner = {
      resolvedProvider: { type: "openrouter" },
      runTurn: vi.fn(() => new Promise((resolve) => {
        resolveTurn = resolve;
      })),
      dispose: vi.fn(),
    };
    const secondRunner = {
      resolvedProvider: { type: "openrouter" },
      runTurn: vi.fn(),
      dispose: vi.fn(),
    };
    provider.createProviderRunner
      .mockReturnValueOnce(firstRunner)
      .mockReturnValueOnce(secondRunner);
    const { frames, manager } = createHarness();

    await startSession(manager, "session-restart-waits", { ...defaultConfig, continuable: true });
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-restart-waits",
        turnId: "turn-1",
        input: "first",
      },
    });
    const restartPromise = startSession(manager, "session-restart-waits", {
      ...defaultConfig,
      continuable: true,
      systemPrompt: "restarted",
    });
    await Promise.resolve();

    expect(provider.createProviderRunner).toHaveBeenCalledTimes(1);
    expect(firstRunner.dispose).not.toHaveBeenCalled();

    resolveTurn({
      text: "done",
      usage: null,
      resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: "thread-1" },
    });
    await restartPromise;

    expect(provider.createProviderRunner).toHaveBeenCalledTimes(2);
    expect(firstRunner.dispose).toHaveBeenCalledTimes(1);
    expect(frames).toContainEqual({
      type: "event",
      event: { type: "turnFinished", sessionId: "session-restart-waits", turnId: "turn-1", usage: null },
    });
    expect(frames.at(-1)).toMatchObject({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: "session-restart-waits",
        snapshot: { sessionId: "session-restart-waits" },
      },
    });
  });

  it("does not wait for running turns from sessions whose ids share prefixes", async () => {
    let resolveTurn!: (value: unknown) => void;
    provider.runTurn.mockImplementation(
      () => new Promise((resolve) => {
        resolveTurn = resolve;
      })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session");
    await startSession(manager, "session:child");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session:child",
        turnId: "turn-1",
        input: "child",
      },
    });
    const restartPromise = startSession(manager, "session", {
      ...defaultConfig,
      systemPrompt: "parent restart",
    });
    await restartPromise;

    expect(provider.createProviderRunner).toHaveBeenCalledTimes(3);
    expect(frames.at(-1)).toMatchObject({
      type: "response",
      response: {
        type: "sessionStarted",
        sessionId: "session",
        snapshot: { sessionId: "session" },
      },
    });

    resolveTurn({
      text: "done",
      usage: null,
      resume: { provider: "openrouter", nativeSessionId: null, nativeThreadId: null },
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session:child", turnId: "turn-1", usage: null },
      });
    });
  });

  it("emits protocol errors for unknown sessions", async () => {
    const { frames, manager } = createHarness();

    await expect(
      manager.handle({
        type: "request",
        request: {
          type: "sendInput",
          sessionId: "missing-session",
          turnId: "turn-missing",
          input: "hello",
        },
      })
    ).resolves.toBeUndefined();
    await expect(
      manager.handle({
        type: "request",
        request: {
          type: "setPlanState",
          sessionId: "missing-session",
          state: { mode: "approved", planText: "ship it", approved: true },
        },
      })
    ).resolves.toBeUndefined();

    expect(frames).toMatchObject([
      {
        type: "event",
        event: {
          type: "error",
          sessionId: "missing-session",
          turnId: "turn-missing",
          message: "Unknown AI session: missing-session",
        },
      },
      {
        type: "event",
        event: {
          type: "error",
          sessionId: "missing-session",
          turnId: null,
          message: "Unknown AI session: missing-session",
        },
      },
    ]);
  });

  it("cancels in-flight turns through the provider signal", async () => {
    provider.runTurn.mockImplementation(
      (_config: unknown, _input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-cancel");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-cancel",
        turnId: "turn-cancel",
        input: "wait",
      },
    });
    await manager.handle({
      type: "cancel",
      sessionId: "session-cancel",
      turnId: "turn-cancel",
    });

    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session-cancel", turnId: "turn-cancel", usage: null },
      });
    });
    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "sessionUpdated",
        sessionId: "session-cancel",
        snapshot: expect.objectContaining({ status: "cancelled" }),
      }),
    });
  });

  it("does not cancel running turns from sessions whose ids share prefixes", async () => {
    let childAborted = false;
    provider.runTurn.mockImplementation(
      (_config: unknown, _input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            childAborted = true;
            reject(new Error("aborted"));
          }, { once: true });
        })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session");
    await startSession(manager, "session:child");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session:child",
        turnId: "turn-1",
        input: "wait",
      },
    });
    await manager.handle({
      type: "cancel",
      sessionId: "session",
      turnId: null,
    });
    await Promise.resolve();

    expect(childAborted).toBe(false);

    await manager.handle({
      type: "cancel",
      sessionId: "session:child",
      turnId: null,
    });
    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "turnFinished", sessionId: "session:child", turnId: "turn-1", usage: null },
      });
    });
    expect(childAborted).toBe(true);
  });

  it("emits an error session snapshot after failed turns", async () => {
    provider.runTurn.mockRejectedValue(new Error("provider failed"));
    const { frames, manager } = createHarness();

    await startSession(manager, "session-error");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-error",
        turnId: "turn-error",
        input: "fail",
      },
    });

    await vi.waitFor(() => {
      expect(frames).toContainEqual({
        type: "event",
        event: { type: "error", sessionId: "session-error", turnId: "turn-error", message: "provider failed" },
      });
    });
    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "sessionUpdated",
        sessionId: "session-error",
        snapshot: expect.objectContaining({ status: "error", error: "provider failed" }),
      }),
    });
    expect(frames).toContainEqual({
      type: "event",
      event: { type: "turnFinished", sessionId: "session-error", turnId: "turn-error", usage: null },
    });
  });

  it("does not import legacy provider runners from the UI backend", () => {
    const files = [
      "src/ai-backend/server.ts",
      "src/ai-backend/session-manager.ts",
      "src/ai-backend/provider.ts",
      "src/ai-backend/providers/index.ts",
      "src/ai-backend/providers/claude.ts",
      "src/ai-backend/providers/codex.ts",
    ];
    const combined = files.map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");

    expect(combined).not.toContain("runProviderSdk");
    expect(combined).not.toContain("runClaudeAgent");
    expect(combined).not.toContain("runCodexAgent");
  });
});
