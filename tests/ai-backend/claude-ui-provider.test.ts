import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withEnvForTest } from "../helpers/provider-env.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { createProviderRunner } from "../../src/ai-backend/provider.js";

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Claude UI provider runtime home lifecycle", () => {
  it("keeps a retained runtime home after a later continuable turn errors", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-claude-ui-provider-"));
    const restoreEnv = withEnvForTest({
      HOME: home,
      AGENT_FRAMEWORK_SDK_PROVIDER: "claude-subscription",
    });
    queryMock.mockReset();
    queryMock
      .mockImplementationOnce(async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "first",
          session_id: "native-1",
        };
      })
      .mockImplementationOnce(async function* () {
        throw new Error("query failed");
      })
      .mockImplementationOnce(async function* () {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "third",
          session_id: "native-3",
        };
      });

    const runner = createProviderRunner({
      model: null,
      workingDir: "/tmp",
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "isolated",
    });

    try {
      await collect(runner.runTurn({
        config: {
          model: null,
          workingDir: "/tmp",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: "first",
        signal: new AbortController().signal,
        turnId: "turn-1",
      }));

      const firstHome = queryMock.mock.calls[0]?.[0]?.options?.env?.CLAUDE_CONFIG_DIR;
      expect(typeof firstHome).toBe("string");
      expect(fs.existsSync(firstHome as string)).toBe(true);

      await expect(collect(runner.runTurn({
        config: {
          model: null,
          workingDir: "/tmp",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: "second",
        signal: new AbortController().signal,
        turnId: "turn-2",
      }))).rejects.toThrow("query failed");

      expect(fs.existsSync(firstHome as string)).toBe(true);

      await collect(runner.runTurn({
        config: {
          model: null,
          workingDir: "/tmp",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: "third",
        signal: new AbortController().signal,
        turnId: "turn-3",
      }));

      expect(queryMock.mock.calls[2]?.[0]?.options?.resume).toBe("native-1");
      expect(queryMock.mock.calls[2]?.[0]?.options?.env?.CLAUDE_CONFIG_DIR).toBe(firstHome);
    } finally {
      await runner.dispose?.();
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
