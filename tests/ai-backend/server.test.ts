import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage, AiSessionConfig, SessionId } from "../../src/ai-protocol/index.js";
import type { AiRuntimeEvent, AiRunTurnInput } from "../../src/ai-backend/runtime-events.js";

const provider = vi.hoisted(() => ({
  createResolvedProviderRunner: vi.fn(),
  runTurn: vi.fn(),
}));

function resolvedProviderFor(config: AiSessionConfig) {
  if (config.model === "invalid-model") throw new Error("Invalid model tier");
  return {
    type: "openrouter",
    mode: "sdk",
    modelId: "anthropic/claude-opus-4.5",
    sdkRuntime: "codex",
    costTracking: "none",
  };
}

vi.mock("../../src/ai-backend/provider.js", () => ({
  createResolvedProviderRunner: provider.createResolvedProviderRunner,
  resolveSessionProvider: resolvedProviderFor,
}));

const defaultConfig: AiSessionConfig = {
  model: null,
  workingDir: null,
  systemPrompt: null,
  continuable: false,
  sdkRuntimeEnvironment: "isolated",
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
    request: { type: "startSession", sessionId, config },
  });
}

async function* events(...items: AiRuntimeEvent[]): AsyncIterable<AiRuntimeEvent> {
  yield* items;
}

describe("AI backend session manager", () => {
  beforeEach(() => {
    provider.createResolvedProviderRunner.mockReset();
    provider.createResolvedProviderRunner.mockImplementation((resolvedProvider: ReturnType<typeof resolvedProviderFor>) => ({
      resolvedProvider,
      runTurn: provider.runTurn,
    }));
    provider.runTurn.mockReset();
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.created", ref: "assistant", content: "" },
        { type: "message.completed", ref: "assistant", content: "done", usage: null }
      )
    );
  });

  it("starts sessions without provider execution or public provider metadata", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-start");

    const started = frames[0];
    expect(started.type).toBe("response");
    if (started.type !== "response" || started.response.type !== "sessionStarted") {
      throw new Error("expected sessionStarted response");
    }
    expect(started.response.snapshot).toMatchObject({
      sessionId: "session-start",
      status: "idle",
      transcript: [],
      toolCalls: [],
      backendProcesses: [],
      continuation: { enabled: false, available: false },
    });
    expect(JSON.stringify(started)).not.toMatch(
      new RegExp(`provider|native(Session|Thread)Id|${["pending", "Tools"].join("")}|resume`, "i")
    );
  });

  it("returns protocol errors for invalid internally resolved sessions", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-invalid", {
      model: "invalid-model",
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
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

  it("reduces a streamed assistant timeline into ordered events and snapshots", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.created", ref: "assistant", content: "" },
        { type: "message.delta", ref: "assistant", delta: "hel" },
        {
          type: "message.completed",
          ref: "assistant",
          content: "hello",
          usage: {
            promptTokens: 1,
            cachedTokens: null,
            completionTokens: 2,
            reasoningTokens: null,
            totalTokens: 3,
          },
        }
      )
    );
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
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const eventsOnly = frames.filter((frame): frame is Extract<AiBackendMessage, { type: "event" }> => frame.type === "event");
    expect(eventsOnly.map((frame) => frame.event.seq)).toEqual(eventsOnly.map((_, index) => index + 1));
    expect(eventsOnly.some((frame) => frame.event.type === "messageDelta")).toBe(true);

    const sessionUpdated = [...eventsOnly].reverse().find((frame) => frame.event.type === "sessionUpdated");
    if (!sessionUpdated || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    expect(sessionUpdated.event.sessionId).toBe("session-turn-success");
    expect(sessionUpdated.event.snapshot.status).toBe("idle");
    expect(sessionUpdated.event.snapshot.transcript).toContainEqual(
      expect.objectContaining({ role: "user", status: "completed" })
    );
    expect(sessionUpdated.event.snapshot.transcript).toContainEqual(
      expect.objectContaining({ role: "assistant", status: "completed", usage: expect.objectContaining({ totalTokens: 3 }) })
    );
    expect(JSON.stringify(frames)).not.toMatch(
      new RegExp(`native(Session|Thread)Id|${["provider", "ToolCallId"].join("")}|${["resume", "MetadataUpdated"].join("")}`)
    );
  });

  it("emits message creation for implicitly materialized assistant messages", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.delta", ref: "assistant", delta: "hel" },
        { type: "message.completed", ref: "assistant", content: "hello", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-implicit-message");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-implicit-message",
        turnId: "turn-1",
        input: "hello",
      },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const assistantCreated = frames.find((frame) =>
      frame.type === "event" &&
      frame.event.type === "messageCreated" &&
      frame.event.message.role === "assistant"
    );
    expect(assistantCreated).toBeDefined();
  });

  it("persists reasoning blocks and preserves them when final text completes", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.reasoning_delta", ref: "assistant", delta: "think" },
        { type: "message.delta", ref: "assistant", delta: "hel" },
        { type: "message.completed", ref: "assistant", content: "hello", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-reasoning");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-reasoning", turnId: "turn-1", input: "hello" },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "messageReasoningDelta", delta: "think" }),
    }));
    const sessionUpdated = [...frames].reverse().find((frame) => frame.type === "event" && frame.event.type === "sessionUpdated");
    if (!sessionUpdated || sessionUpdated.type !== "event" || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    const assistant = sessionUpdated.event.snapshot.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "reasoning", text: "think" }, { type: "text", text: "hello" }]);
  });

  it("removes stale interleaved text blocks when final text completes", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.delta", ref: "assistant", delta: "draft " },
        { type: "message.reasoning_delta", ref: "assistant", delta: "think" },
        { type: "message.delta", ref: "assistant", delta: "tail" },
        { type: "message.completed", ref: "assistant", content: "final", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-interleaved-final");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-interleaved-final", turnId: "turn-1", input: "hello" },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const sessionUpdated = [...frames].reverse().find((frame) => frame.type === "event" && frame.event.type === "sessionUpdated");
    if (!sessionUpdated || sessionUpdated.type !== "event" || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    const assistant = sessionUpdated.event.snapshot.transcript.find((entry) => entry.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "final" }, { type: "reasoning", text: "think" }]);
  });

  it("applies provider plan updates without downgrading approved plans", async () => {
    provider.runTurn.mockImplementation(() =>
      events({ type: "plan.updated", state: { mode: "planning", planText: "Provider plan", approved: false } })
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-plan");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-plan", turnId: "turn-1", input: "plan" },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    expect(frames).toContainEqual(expect.objectContaining({
      type: "event",
      event: expect.objectContaining({ type: "planStateChanged", state: { mode: "planning", planText: "Provider plan", approved: false } }),
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
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-plan", turnId: "turn-2", input: "plan again" },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished" && frame.event.turnId === "turn-2")).toBe(true);
    });
    const sessionUpdated = [...frames].reverse().find((frame) => frame.type === "event" && frame.event.type === "sessionUpdated");
    if (!sessionUpdated || sessionUpdated.type !== "event" || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    expect(sessionUpdated.event.snapshot.plan).toEqual({ mode: "approved", planText: "Updated provider plan", approved: true });
  });

  it("returns reconnect snapshots and events since a cursor", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-reconnect");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-reconnect",
        turnId: "turn-1",
        input: "hello",
      },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    await manager.handle({
      type: "request",
      request: { type: "getSessionSnapshot", sessionId: "session-reconnect" },
    });
    await manager.handle({
      type: "request",
      request: { type: "eventsSince", sessionId: "session-reconnect", afterSeq: 2 },
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
    expect(response.response.events.every((event) => event.seq > 2)).toBe(true);
    expect(response.response.snapshot.lastEventSeq).toBeGreaterThan(2);
  });

  it("keeps streamed provider failures in the session snapshot", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        { type: "message.created", ref: "assistant", content: "" },
        { type: "message.failed", ref: "assistant", error: new Error("native provider detail") }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-stream-failure");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-stream-failure",
        turnId: "turn-1",
        input: "hello",
      },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const sessionUpdates = frames.filter((frame): frame is Extract<AiBackendMessage, { type: "event" }> =>
      frame.type === "event" && frame.event.type === "sessionUpdated"
    );
    const lastSessionUpdate = sessionUpdates.at(-1);
    if (!lastSessionUpdate || lastSessionUpdate.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    expect(lastSessionUpdate.event.snapshot.status).toBe("error");
    expect(lastSessionUpdate.event.snapshot.error).toMatchObject({
      code: "runtime_error",
      message: "Runtime operation failed",
    });
    expect(JSON.stringify(frames)).not.toContain("native provider detail");
  });

  it("terminates active operations when a turn fails after tool activity starts", async () => {
    provider.runTurn.mockImplementation(async function* () {
      yield {
        type: "tool.created",
        ref: "tool-ref",
        name: "inspect",
        input: { text: "inspect(path=\".\")" },
      };
      yield { type: "tool.updated", ref: "tool-ref", status: "running" };
      yield { type: "backend_process.created", ref: "process-ref", title: "background work" };
      yield { type: "backend_process.updated", ref: "process-ref", status: "running" };
      throw new Error("native provider detail");
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-runtime-failure-active");
    await manager.handle({
      type: "request",
      request: {
        type: "sendInput",
        sessionId: "session-runtime-failure-active",
        turnId: "turn-1",
        input: "hello",
      },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const sessionUpdates = frames.filter((frame): frame is Extract<AiBackendMessage, { type: "event" }> =>
      frame.type === "event" && frame.event.type === "sessionUpdated"
    );
    const lastSessionUpdate = sessionUpdates.at(-1);
    if (!lastSessionUpdate || lastSessionUpdate.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    expect(lastSessionUpdate.event.snapshot.status).toBe("error");
    expect(lastSessionUpdate.event.snapshot.toolCalls).toContainEqual(
      expect.objectContaining({ status: "cancelled" })
    );
    expect(lastSessionUpdate.event.snapshot.backendProcesses).toContainEqual(
      expect.objectContaining({ status: "cancelled" })
    );
    expect(JSON.stringify(frames)).not.toContain("native provider detail");
  });

  it("reuses one provider runner across turns in a session", async () => {
    const { frames, manager } = createHarness();

    await startSession(manager, "session-runner-reuse", { ...defaultConfig, continuable: true });
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-runner-reuse", turnId: "turn-1", input: "first" },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished" && frame.event.turnId === "turn-1")).toBe(true);
    });
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-runner-reuse", turnId: "turn-2", input: "second" },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished" && frame.event.turnId === "turn-2")).toBe(true);
    });
    expect(provider.createResolvedProviderRunner).toHaveBeenCalledTimes(1);
    expect(provider.runTurn).toHaveBeenCalledTimes(2);
    const sessionUpdated = [...frames].reverse().find((frame) => frame.type === "event" && frame.event.type === "sessionUpdated");
    if (!sessionUpdated || sessionUpdated.type !== "event" || sessionUpdated.event.type !== "sessionUpdated") {
      throw new Error("expected sessionUpdated event");
    }
    const assistantEntries = sessionUpdated.event.snapshot.transcript.filter((entry) => entry.role === "assistant");
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries.every((entry) => entry.status === "completed")).toBe(true);
    expect(new Set(assistantEntries.map((entry) => entry.id)).size).toBe(2);
  });

  it("rejects overlapping turns and session replacement for the same session", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.runTurn.mockImplementation(async function* () {
      await pending;
      yield { type: "message.completed", ref: "assistant", content: "done", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-overlap", { ...defaultConfig, continuable: true });
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-overlap", turnId: "turn-1", input: "first" },
    });
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-overlap", turnId: "turn-2", input: "second" },
    });
    await startSession(manager, "session-overlap", { ...defaultConfig, systemPrompt: "replacement" });

    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "error",
        sessionId: "session-overlap",
        turnId: "turn-2",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    });
    expect(frames).toContainEqual({
      type: "response",
      response: expect.objectContaining({
        type: "error",
        sessionId: "session-overlap",
        error: expect.objectContaining({ code: "conflict" }),
      }),
    });

    release();
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
  });

  it("does not reject turns for sessions whose ids are prefixes of running sessions", async () => {
    const releases: Array<() => void> = [];
    provider.runTurn.mockImplementation(async function* () {
      await new Promise<void>((resolve) => releases.push(resolve));
      yield { type: "message.completed", ref: "assistant", content: "done", usage: null };
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session");
    await startSession(manager, "session:child");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session:child", turnId: "turn-1", input: "child" },
    });
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session", turnId: "turn-1", input: "parent" },
    });

    expect(provider.runTurn).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
    await vi.waitFor(() => {
      expect(frames.filter((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toHaveLength(2);
    });
  });

  it("emits protocol errors for unknown sessions", async () => {
    const { frames, manager } = createHarness();

    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "missing-session", turnId: "turn-missing", input: "hello" },
    });
    await manager.handle({
      type: "request",
      request: { type: "getSessionSnapshot", sessionId: "missing-session" },
    });

    expect(frames).toMatchObject([
      { type: "response", response: { type: "error", sessionId: "missing-session", error: { code: "not_found" } } },
      { type: "response", response: { type: "error", sessionId: "missing-session", error: { code: "not_found" } } },
    ]);
  });

  it("cancels in-flight turns and active operations through the provider signal", async () => {
    provider.runTurn.mockImplementation(async function* (input: AiRunTurnInput) {
      input.signal.throwIfAborted();
      yield {
        type: "tool.created",
        ref: "tool-ref",
        name: "inspect",
        input: { text: "inspect(path=\".\")", fields: { path: "." } },
      };
      yield { type: "tool.updated", ref: "tool-ref", status: "running" };
      yield { type: "tool.progress", ref: "tool-ref", progress: "working" };
      yield { type: "backend_process.created", ref: "process-ref", title: "background work" };
      yield { type: "backend_process.updated", ref: "process-ref", status: "running" };
      yield { type: "backend_process.progress", ref: "process-ref", progress: "working" };
      input.signal.throwIfAborted();
      await new Promise((_resolve, reject) => {
        if (input.signal.aborted) {
          reject(new Error("aborted"));
          return;
        }
        input.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const { frames, manager } = createHarness();

    await startSession(manager, "session-cancel");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-cancel", turnId: "turn-cancel", input: "wait" },
    });
    await manager.handle({ type: "cancel", sessionId: "session-cancel", turnId: "turn-cancel" });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "toolCallUpdated",
        toolCall: expect.objectContaining({
          status: "cancelled",
          wait: null,
          progress: null,
          elapsedMs: null,
        }),
      }),
    });
    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "backendProcessUpdated",
        process: expect.objectContaining({
          status: "cancelled",
          progress: null,
          elapsedMs: null,
        }),
      }),
    });
  });

  it("tracks tool and backend process lifecycle events", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "tool.created",
          ref: "tool-ref",
          name: "inspect",
          input: { text: "inspect(path=\".\")", fields: { path: "." } },
        },
        { type: "tool.updated", ref: "tool-ref", status: "running" },
        { type: "tool.output", ref: "tool-ref", output: [{ type: "text", text: "started" }] },
        { type: "tool.promoted_to_backend_process", toolRef: "tool-ref", processRef: "process-ref", title: "background work" },
        { type: "backend_process.updated", ref: "process-ref", status: "running" },
        { type: "backend_process.progress", ref: "process-ref", progress: "50%" },
        { type: "backend_process.completed", ref: "process-ref", output: [{ type: "text", text: "done" }] },
        { type: "message.completed", ref: "assistant", content: "done", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-tools");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-tools", turnId: "turn-tools", input: "run" },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    expect(frames.some((frame) => frame.type === "event" && frame.event.type === "toolCallCreated")).toBe(true);
    expect(frames.some((frame) => frame.type === "event" && frame.event.type === "toolCallPromotedToBackendProcess")).toBe(true);
    expect(frames.some((frame) => frame.type === "event" && frame.event.type === "backendProcessProgress")).toBe(true);
    expect(JSON.stringify(frames)).not.toMatch(
      new RegExp(`${["provider", "ToolCallId"].join("")}|native(Session|Thread)Id`)
    );
  });

  it("stores completed tool results with cumulative output once", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "tool.created",
          ref: "tool-ref",
          name: "inspect",
          input: { text: "inspect(path=\".\")" },
        },
        { type: "tool.output", ref: "tool-ref", output: [{ type: "text", text: "started" }] },
        { type: "tool.completed", ref: "tool-ref", output: [{ type: "text", text: "done" }] },
        { type: "message.completed", ref: "assistant", content: "done", usage: null }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-tool-output");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-tool-output", turnId: "turn-tools", input: "run" },
    });

    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "turnFinished")).toBe(true);
    });
    const updated = [...frames].reverse().find((frame) =>
      frame.type === "event" &&
      frame.event.type === "toolCallUpdated" &&
      frame.event.toolCall.status === "completed"
    );
    if (!updated || updated.type !== "event" || updated.event.type !== "toolCallUpdated") {
      throw new Error("expected completed tool update");
    }
    expect(updated.event.toolCall.output).toEqual([
      { type: "text", text: "started" },
      { type: "text", text: "done" },
    ]);
    expect(updated.event.toolCall.result?.output).toEqual(updated.event.toolCall.output);
  });

  it("handles generic tool decisions without provider tool ids", async () => {
    const submitToolDecision = vi.fn();
    provider.createResolvedProviderRunner.mockImplementation(() => ({
      resolvedProvider: { type: "openrouter" },
      runTurn: provider.runTurn,
      submitToolDecision,
    }));
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "tool.created",
          ref: "tool-ref",
          name: "inspect",
          input: { text: "inspect(path=\".\")" },
        },
        { type: "tool.updated", ref: "tool-ref", status: "waiting", waitReason: "approval" }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-decision");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-decision", turnId: "turn-1", input: "run" },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "toolCallUpdated")).toBe(true);
    });
    await manager.handle({
      type: "request",
      request: {
        type: "submitToolDecision",
        sessionId: "session-decision",
        turnId: "turn-1",
        decision: { toolCallId: "tool-1", decision: "approve", reason: null },
      },
    });

    expect(submitToolDecision).toHaveBeenCalledWith({ toolCallId: "tool-ref", decision: "approve", reason: null });
    expect(frames.at(-1)).toEqual({
      type: "response",
      response: { type: "accepted", sessionId: "session-decision", turnId: "turn-1" },
    });
  });

  it("marks unsupported tool approval without failing the tool", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "tool.created",
          ref: "tool-ref",
          name: "inspect",
          input: { text: "inspect(path=\".\")" },
        },
        { type: "tool.updated", ref: "tool-ref", status: "waiting", waitReason: "approval" }
      )
    );
    const { frames, manager } = createHarness();

    await startSession(manager, "session-unsupported-decision");
    await manager.handle({
      type: "request",
      request: { type: "sendInput", sessionId: "session-unsupported-decision", turnId: "turn-1", input: "run" },
    });
    await vi.waitFor(() => {
      expect(frames.some((frame) => frame.type === "event" && frame.event.type === "toolCallUpdated")).toBe(true);
    });
    await manager.handle({
      type: "request",
      request: {
        type: "submitToolDecision",
        sessionId: "session-unsupported-decision",
        turnId: "turn-1",
        decision: { toolCallId: "tool-1", decision: "approve", reason: null },
      },
    });

    expect(frames).toContainEqual({
      type: "event",
      event: expect.objectContaining({
        type: "toolCallUpdated",
        toolCall: expect.objectContaining({
          status: "unsupported",
          result: expect.objectContaining({ state: "unsupported" }),
        }),
      }),
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
