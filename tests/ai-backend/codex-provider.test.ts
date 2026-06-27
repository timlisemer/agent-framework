import fs from "node:fs";
import os from "node:os";
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
import { PROVIDER_TYPES } from "../../src/utils/provider-config.js";
import { withEnvForTest } from "../helpers/provider-env.js";

describe("AI backend Codex provider helpers", () => {
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-test-"));
    const restoreEnv = withEnvForTest({
      HOME: home,
      CODEX_HOME: "/native/codex",
      OPENAI_API_KEY: "openai-key",
      CODEX_API_KEY: "codex-key",
      OPENROUTER_API_KEY: "openrouter-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    try {
      const env = buildCodexSessionEnv("user", null, true, "managedAstral");

      expect(env.CODEX_HOME).toBe("/native/codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      restoreEnv();
    }
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
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-binding-test-"));
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("prefers an explicit resume transcript path when present", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-explicit-binding-test-"));
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolves native transcript bindings from CODEX_HOME when runtime home is native", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-native-binding-test-"));
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
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
