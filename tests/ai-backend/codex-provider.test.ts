import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexConfig,
  buildCodexEnv,
  buildCodexSessionEnv,
  buildCodexThreadOptions,
  codexDirectToolUseErrorResult,
  codexTurnHasDirectForbiddenItems,
  normalizeCodexAiUsage,
  resolveCodexTranscriptBinding,
  shouldPersistCodexHistory,
  startOrResumeCodexThread,
} from "../../src/providers/codex-agent-runtime.js";
import { runCodexTranscriptTurn } from "../../src/ai-backend/provider.js";
import { mapCodexProviderEvent, mapCodexStructuredEvent } from "../../adapters/codex/provider-events.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import { PROVIDER_TYPES } from "../../src/utils/provider-config.js";
import { withEnvForTest } from "../helpers/provider-env.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { testStartRunCommand } from "../helpers/scenario-fixtures.js";
import {
  withTemporaryTestRoot,
  withTemporaryTestRootSync,
} from "../helpers/temporary-root.js";

describe("AI backend Codex provider helpers", () => {
  it("maps completed-turn usage through the adapter-owned normalizer", () => {
    expect(mapCodexProviderEvent({
      type: "turn.completed",
      usage: { input_tokens: 9, cached_input_tokens: 4, output_tokens: 2 },
    }, "turn-1")).toEqual([{
      type: "providerStateObserved",
      data: {
        usage: {
          promptTokens: 9,
          cachedTokens: 4,
          completionTokens: 2,
          reasoningTokens: null,
          totalTokens: 11,
        },
      },
    }]);
  });

  it("preserves the assistant response from a run-only Codex thread", async () => {
    const events = [];
    for await (const event of runCodexTranscriptTurn({
      liveSession: {
        thread: { async run() { return { finalResponse: "fallback response", usage: {} }; } },
      },
      prompt: "hello",
      turnId: "turn-fallback",
      signal: new AbortController().signal,
    })) events.push(event);
    expect(events).toContainEqual(expect.objectContaining({
      type: "assistantMessageCompleted", turnId: "turn-fallback", content: "fallback response",
    }));
  });
  it("represents Codex tool starts as post-start observations", () => {
    expect(mapCodexStructuredEvent({
      type: "item.started",
      item: { id: "command-1", type: "command_execution", command: "pwd" },
    }, "turn-1")).toEqual([{
      type: "toolExecutionObserved",
      toolCallId: "command-1",
      turnId: "turn-1",
      name: "Bash",
      input: { command: "pwd" },
      inputDigest: digestScenarioValue({ command: "pwd" }),
    }]);
  });

  it("canonicalizes Codex SDK file changes through the adapter tool mapping", () => {
    expect(mapCodexStructuredEvent({
      type: "item.started",
      item: {
        id: "change-1",
        type: "file_change",
        changes: [{ path: "src/one.ts" }, { path: "src/two.ts" }],
      },
    }, "turn-1")).toEqual([{
      type: "toolExecutionObserved",
      toolCallId: "change-1",
      turnId: "turn-1",
      name: "Edit",
      input: {
        file_path: "src/one.ts",
        file_paths: ["src/one.ts", "src/two.ts"],
      },
      inputDigest: digestScenarioValue({
        file_path: "src/one.ts",
        file_paths: ["src/one.ts", "src/two.ts"],
      }),
    }]);
  });

  it("canonicalizes structured Agent Framework MCP starts without losing their arguments", () => {
    const input = { working_dir: "/workspace", nested: { retained: true } };
    expect(mapCodexStructuredEvent({
      type: "item.started",
      item: {
        id: "mcp-check-1",
        type: "mcp_tool_call",
        server: "agent-framework",
        tool: "check",
        arguments: input,
      },
    }, "turn-1")).toEqual([{
      type: "toolExecutionObserved",
      toolCallId: "mcp-check-1",
      turnId: "turn-1",
      name: "mcp-check",
      input,
      inputDigest: digestScenarioValue(input),
    }]);
  });

  it("maps a complete Codex tool lifecycle without duplicating cumulative output", async () => {
    await runCodexToolLifecycle({
      temporaryPrefix: "agent-framework-codex-lifecycle-",
      runId: "codex-lifecycle-run",
      turnId: "turn-1",
      frames: [
        { type: "item.started", item: { id: "command-1", type: "command_execution", command: "pwd" } },
        { type: "item.updated", item: { id: "command-1", type: "command_execution", command: "pwd", aggregated_output: "a" } },
        { type: "item.updated", item: { id: "command-1", type: "command_execution", command: "pwd", aggregated_output: "ab" } },
        { type: "item.completed", item: { id: "command-1", type: "command_execution", command: "pwd", aggregated_output: "ab", exit_code: 0 } },
      ],
      expectedTool: {
        id: "command-1",
        status: "completed",
        output: ["ab"],
      },
    });
  });

  it("retains cumulative output from a failed Codex command in the canonical snapshot", async () => {
    await runCodexToolLifecycle({
      temporaryPrefix: "agent-framework-codex-failed-lifecycle-",
      runId: "codex-failed-lifecycle-run",
      turnId: "failed-turn",
      frames: [
        { type: "item.started", item: { id: "failed-command", type: "command_execution", command: "false" } },
        {
          type: "item.completed",
          item: {
            id: "failed-command",
            type: "command_execution",
            command: "false",
            aggregated_output: "permission denied",
            exit_code: 7,
          },
        },
      ],
      expectedTool: {
        id: "failed-command",
        status: "failed",
        error: "Tool execution failed",
        output: ["permission denied"],
      },
    });
  });

  it("ignores malformed Codex entity lifecycle frames without stable item IDs", () => {
    for (const type of ["item.started", "item.updated", "item.completed"]) {
      expect(mapCodexStructuredEvent({
        type,
        item: { type: "command_execution", command: "pwd", aggregated_output: "output" },
      }, "turn-1")).toEqual([]);
    }
  });

  it("builds OpenRouter Codex config without forcing ChatGPT login", () => {
    const config = buildCodexConfig("isolated", "/tmp/codex-home", true);

    expect(config?.model_provider).toBe("openrouter");
    expect(config?.show_raw_agent_reasoning).toBe(true);
    expect(config?.history).toEqual({ persistence: "none" });
    expect(config?.forced_login_method).toBeUndefined();
    expect(config?.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
  });

  it("keeps OpenRouter Codex provider routing for user runtime sessions", () => {
    const config = buildCodexConfig("user", null, true, false);

    expect(config?.model_provider).toBe("openrouter");
    expect(config?.show_raw_agent_reasoning).toBe(true);
    expect(config?.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
    expect(config?.log_dir).toBeUndefined();
    expect(config?.forced_login_method).toBeUndefined();
    expect(config?.history).toBeUndefined();
  });

  it("does not disable Codex history for continuable sessions", () => {
    const config = buildCodexConfig("isolated", "/tmp/codex-home", false, true);

    expect(config?.history).toBeUndefined();
    expect(config?.forced_login_method).toBe("chatgpt");
    expect(config?.show_raw_agent_reasoning).toBe(true);
  });

  it("does not persist Codex history for volatile runtime homes", () => {
    expect(shouldPersistCodexHistory(true, "normal")).toBe(true);
    expect(shouldPersistCodexHistory(true, "write")).toBe(true);
    expect(shouldPersistCodexHistory(true, "none")).toBe(false);
    expect(shouldPersistCodexHistory(true, "volatile")).toBe(false);
    expect(shouldPersistCodexHistory(false, "normal")).toBe(false);
  });

  it("removes API-key env for OpenAI subscription sessions", () => {
    const env = buildCodexEnv("isolated", "/tmp/codex-home", true);

    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("uses process runtime home and config for user runtime sessions", () => {
    const restoreEnv = withEnvForTest({
      CODEX_HOME: "/home/user/.codex",
      OPENAI_API_KEY: "openai-key",
      OPENROUTER_API_KEY: "openrouter-key",
    });
    try {
      const env = buildCodexEnv("user", null, true);
      const config = buildCodexConfig("user", null, false, true);

      expect(env.CODEX_HOME).toBe("/home/user/.codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(config?.show_raw_agent_reasoning).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it("scrubs API keys without overriding materialized runtime homes", () => {
    withTemporaryTestRootSync("agent-framework-codex-test-", (home) => {
      const restoreEnv = withEnvForTest({
        HOME: home,
        CODEX_HOME: "/native/codex",
        OPENAI_API_KEY: "openai-key",
        CODEX_API_KEY: "codex-key",
        OPENROUTER_API_KEY: "openrouter-key",
        ANTHROPIC_API_KEY: "anthropic-key",
      });
      try {
        const env = buildCodexSessionEnv("user", null, true, "managed");

        expect(env.CODEX_HOME).toBe("/native/codex");
        expect(env.OPENAI_API_KEY).toBeUndefined();
        expect(env.CODEX_API_KEY).toBeUndefined();
        expect(env.OPENROUTER_API_KEY).toBeUndefined();
        expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      } finally {
        restoreEnv();
      }
    });
  });

  it("requires SDK support when resuming a native Codex thread", () => {
    const startThread = vi.fn(() => ({ id: "new-thread", run: vi.fn() }));

    expect(() =>
      startOrResumeCodexThread({ startThread }, { workingDirectory: "/repo" }, "existing-thread")
    ).toThrow("Codex SDK does not support native thread resume.");
    expect(startThread).not.toHaveBeenCalled();
  });

  it("keeps Codex runtime policy separated by execution mode and runtime environment", () => {
    const direct = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "isolated",
      runtimeExecutionMode: "direct",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "direct",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });
    const sdk = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "isolated",
      runtimeExecutionMode: "sdk",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "sdk",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });
    const user = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "user",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "sdk",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "high",
      costTracking: "none",
    });

    expect(direct).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
    });
    expect(sdk).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
    });
    expect(user).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
    });
    expect(user).not.toHaveProperty("sandboxMode");
    expect(user).not.toHaveProperty("approvalPolicy");
    expect(user).not.toHaveProperty("networkAccessEnabled");
    expect(user).not.toHaveProperty("webSearchMode");
    expect(user).not.toHaveProperty("webSearchEnabled");
  });

  it("detects tool-capable Codex items as direct-mode contract violations", () => {
    for (const type of ["command_execution", "file_change", "mcp_tool_call", "web_search"]) {
      expect(codexTurnHasDirectForbiddenItems({ items: [{ type }] })).toBe(true);
    }

    expect(codexTurnHasDirectForbiddenItems({
      items: [
        { type: "agent_message" },
        { type: "reasoning" },
        { type: "todo_list" },
      ],
    })).toBe(false);
    expect(codexTurnHasDirectForbiddenItems({ finalResponse: "ok" })).toBe(false);
  });

  it("returns a direct error result when a Codex direct turn reports tool use", () => {
    const result = codexDirectToolUseErrorResult({
      finalResponse: "tool-informed answer",
      items: [{ type: "command_execution" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "direct",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });

    expect(result).toMatchObject({
      text: "[DIRECT ERROR] Direct Codex runtime attempted tool use",
      provider: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      modelName: "gpt-5.3-codex",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    });
  });

  it("normalizes Codex SDK usage into AI protocol token usage", () => {
    expect(normalizeCodexAiUsage({
      input_tokens: 10,
      cached_input_tokens: 2,
      output_tokens: 5,
      reasoning_output_tokens: 3,
    }, (value) => value ?? null)).toEqual({
      promptTokens: 10,
      cachedTokens: 2,
      completionTokens: 5,
      reasoningTokens: 3,
      totalTokens: 15,
    });
  });

  it("resolves transcript bindings by native thread id and project cwd", () => {
    withTemporaryTestRootSync("agent-framework-codex-binding-test-", (home) => {
      const projectDir = path.join(home, "project");
      const transcriptDir = path.join(home, "codex-home", "sessions", "2026", "06", "26");
      const transcriptPath = path.join(transcriptDir, "thread-1.jsonl");
      fs.mkdirSync(transcriptDir, { recursive: true });
      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-1", cwd: projectDir },
      })}\n`);

      expect(resolveCodexTranscriptBinding({
        runtimeHomeRoot: path.join(home, "codex-home"),
        threadId: "thread-1",
        workingDir: projectDir,
      })).toBe(transcriptPath);
      expect(resolveCodexTranscriptBinding({
        runtimeHomeRoot: path.join(home, "codex-home"),
        threadId: "thread-1",
        workingDir: path.join(home, "other-project"),
      })).toBeNull();
    });
  });

  it("prefers an explicit resume transcript path when present", () => {
    withTemporaryTestRootSync("agent-framework-codex-explicit-binding-test-", (home) => {
      const transcriptPath = path.join(home, "resume.jsonl");
      fs.writeFileSync(transcriptPath, "\n");
      expect(resolveCodexTranscriptBinding({
        runtimeHomeRoot: null,
        threadId: null,
        workingDir: "/repo",
        resumeTranscriptPath: transcriptPath,
      })).toBe(transcriptPath);
      expect(resolveCodexTranscriptBinding({
        runtimeHomeRoot: null,
        threadId: null,
        workingDir: "/repo",
        resumeTranscriptPath: path.join(home, "missing.jsonl"),
      })).toBeNull();
    });
  });

  it("resolves native transcript bindings from CODEX_HOME when runtime home is native", () => {
    withTemporaryTestRootSync("agent-framework-codex-native-binding-test-", (home) => {
      const restoreEnv = withEnvForTest({ CODEX_HOME: path.join(home, "custom-codex-home") });
      try {
        const projectDir = path.join(home, "project");
        const transcriptDir = path.join(home, "custom-codex-home", "sessions", "2026", "06", "26");
        const transcriptPath = path.join(transcriptDir, "thread-native.jsonl");
        fs.mkdirSync(transcriptDir, { recursive: true });
        fs.writeFileSync(transcriptPath, `${JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-native", cwd: projectDir },
        })}\n`);

        expect(resolveCodexTranscriptBinding({
          runtimeHomeRoot: null,
          threadId: "thread-native",
          workingDir: projectDir,
        })).toBe(transcriptPath);
      } finally {
        restoreEnv();
      }
    });
  });
});

async function runCodexToolLifecycle(input: {
  temporaryPrefix: string;
  runId: string;
  turnId: string;
  frames: Record<string, unknown>[];
  expectedTool: Record<string, unknown>;
}): Promise<void> {
  await withTemporaryTestRoot(input.temporaryPrefix, async (root) => {
    const runtime = createTestScenarioRuntime({ root });
    const source = { kind: "providerSdk" as const, provider: "codex" };
    await runtime.dispatch(testStartRunCommand({ runId: input.runId, source }));
    let commandIndex = 0;
    for (const frame of input.frames) {
      for (const payload of mapCodexStructuredEvent(frame, input.turnId)) {
        commandIndex += 1;
        await runtime.dispatch({
          runId: input.runId,
          commandId: `${input.runId}-lifecycle-${commandIndex}`,
          source,
          recordedAt: `2026-07-15T12:00:0${commandIndex}.000Z`,
          payload,
        });
      }
    }

    expect(commandIndex).toBe(2);
    expect((await runtime.snapshot(input.runId)).toolCalls).toMatchObject([input.expectedTool]);
  });
}
