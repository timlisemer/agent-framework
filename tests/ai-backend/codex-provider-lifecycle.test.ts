import { describe, expect, it, vi } from "vitest";
import type { ProviderSessionConfig } from "../../src/providers/provider-contract.js";

const { createCodexLiveSessionMock } = vi.hoisted(() => ({
  createCodexLiveSessionMock: vi.fn(),
}));

vi.mock("../../src/providers/codex-agent-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/providers/codex-agent-runtime.js")>();
  return { ...actual, createCodexLiveSession: createCodexLiveSessionMock };
});

import { createResolvedProviderRunner } from "../../src/ai-backend/provider.js";
import { testResolvedProvider } from "../helpers/scenario-fixtures.js";

describe("Codex provider session lifecycle", () => {
  it("persists only continuable provider history and disposes one-shot sessions", async () => {
    const sessions: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    createCodexLiveSessionMock.mockImplementation(async () => {
      const session = {
        runtimeHome: { root: null },
        thread: {
          id: `thread-${sessions.length + 1}`,
          async run() { return { finalResponse: "done", usage: {} }; },
        },
        dispose: vi.fn(),
      };
      sessions.push(session);
      return session;
    });
    const resolvedProvider = testResolvedProvider({ sdkRuntime: "codex" });
    const run = async (continuable: boolean) => {
      const runner = createResolvedProviderRunner(resolvedProvider);
      const config: ProviderSessionConfig = {
        model: null,
        workingDir: "/workspace",
        systemPrompt: null,
        continuable,
        sdkRuntimeEnvironment: "isolated",
        sdkRuntimeHome: "native",
      };
      const events = [];
      for await (const event of runner.runTurn({
        config,
        prompt: "hello",
        turnId: `turn-${continuable ? "continuable" : "one-shot"}`,
        signal: new AbortController().signal,
      })) events.push(event);
      return { events, runner };
    };

    const oneShot = await run(false);
    const continuable = await run(true);

    expect(createCodexLiveSessionMock.mock.calls.map((call) => call[3])).toEqual([false, true]);
    expect(oneShot.events).toContainEqual(expect.objectContaining({ type: "providerStateObserved" }));
    expect(continuable.events).toContainEqual({
      type: "continuationStateChanged",
      data: { available: true },
    });
    expect(sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(sessions[1]?.dispose).not.toHaveBeenCalled();

    await continuable.runner.dispose?.();
    expect(sessions[1]?.dispose).toHaveBeenCalledOnce();
  });
});
