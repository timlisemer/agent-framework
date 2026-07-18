import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { withEnvForTest } from "../helpers/provider-env.js";

const queryMock = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

import { createProviderRunner } from "../../src/ai-backend/provider.js";
import { ProviderSettlementTimeoutError } from "../../src/ai-backend/provider-settlement.js";
import { withTemporaryTestRoot } from "../helpers/temporary-root.js";

async function collect(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Claude provider runtime home lifecycle", () => {
  it("propagates a producer timeout when a returned Claude turn cannot abort its SDK stream", async () => {
    await withTemporaryTestRoot("agent-framework-claude-timeout-", async (home) => {
      const restoreEnv = withEnvForTest({
        HOME: home,
        AGENT_FRAMEWORK_SDK_PROVIDER: "claude-subscription",
      });
      let releaseProducer!: () => void;
      let markProducerFinished!: () => void;
      const producerBarrier = new Promise<void>((resolve) => { releaseProducer = resolve; });
      const producerFinished = new Promise<void>((resolve) => { markProducerFinished = resolve; });
      queryMock.mockReset();
      queryMock.mockImplementation(async function* () {
        try {
          yield {
            type: "assistant",
            uuid: "timeout-message",
            message: { content: [{ type: "text", text: "first event" }] },
          };
          await producerBarrier;
        } finally {
          markProducerFinished();
        }
      });
      const runner = createProviderRunner({
        model: null,
        workingDir: "/tmp",
        systemPrompt: null,
        continuable: false,
        sdkRuntimeEnvironment: "isolated",
      });
      const iterator = runner.runTurn({
        config: {
          model: null,
          workingDir: "/tmp",
          systemPrompt: null,
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
        prompt: "timeout",
        signal: new AbortController().signal,
        turnId: "timeout-turn",
      })[Symbol.asyncIterator]();

      try {
        await expect(iterator.next()).resolves.toMatchObject({
          done: false,
          value: { type: "assistantMessageCompleted", content: "first event" },
        });
        const returning = iterator.return?.();
        expect(returning).toBeDefined();
        await expect(returning).rejects.toBeInstanceOf(ProviderSettlementTimeoutError);
        releaseProducer();
        await producerFinished;
      } finally {
        releaseProducer();
        await runner.dispose?.();
        restoreEnv();
      }
    });
  });

  it("keeps a retained runtime home after a later continuable turn errors", async () => {
    await withTemporaryTestRoot("agent-framework-claude-provider-", async (home) => {
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
      }
    });
  });
});
