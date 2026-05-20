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
