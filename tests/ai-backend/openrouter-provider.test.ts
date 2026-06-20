import { afterEach, describe, expect, it } from "vitest";
import {
  buildClaudeQueryOptions,
  buildCodexTurnInput,
  createProviderRunner,
  createResumeProviderRunner,
  ResumeProviderMismatchError,
} from "../../src/ai-backend/provider.js";
import { buildCodexThreadOptions } from "../../src/providers/codex-agent-runtime.js";
import { PROVIDER_TYPES, resetProviderConfig } from "../../src/utils/provider-config.js";
import { clearProviderEnvForTest } from "../helpers/provider-env.js";

describe("AI backend OpenRouter provider resolution", () => {
  const restore = clearProviderEnvForTest();

  afterEach(() => {
    restore();
  });

  it("uses Codex as the OpenRouter SDK runtime by default", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openrouter";
    resetProviderConfig();

    const runner = createProviderRunner({
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
    });

    expect(runner.resolvedProvider.type).toBe(PROVIDER_TYPES.OPENROUTER);
    expect(runner.resolvedProvider.sdkRuntime).toBe("codex");
  });

  it("allows explicit Claude runtime override for OpenRouter SDK mode", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openrouter";
    process.env.AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME = "claude";
    resetProviderConfig();

    const runner = createProviderRunner({
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
    });

    expect(runner.resolvedProvider.type).toBe(PROVIDER_TYPES.OPENROUTER);
    expect(runner.resolvedProvider.sdkRuntime).toBe("claude");
  });

  it("uses internal provider resolution rather than session config provider selection", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openai-subscription";
    resetProviderConfig();

    const runner = createProviderRunner({
      model: null,
      workingDir: null,
      systemPrompt: null,
      continuable: false,
      sdkRuntimeEnvironment: "isolated",
    });

    expect(runner.resolvedProvider.type).toBe(PROVIDER_TYPES.OPENAI_SUBSCRIPTION);
    expect(runner.resolvedProvider.sdkRuntime).toBe("codex");
  });

  it("creates resume runners only for targets matching the configured SDK runtime", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openai-subscription";
    resetProviderConfig();

    const runner = createResumeProviderRunner({
      model: null,
      workingDir: "/repo",
      systemPrompt: null,
      continuable: true,
      sdkRuntimeEnvironment: "user",
      sdkRuntimeHome: "managedAstral",
    }, {
      provider: "codex",
      threadId: "codex-thread",
      transcriptPath: "/tmp/codex-session.jsonl",
    });

    expect(runner.resolvedProvider.type).toBe(PROVIDER_TYPES.OPENAI_SUBSCRIPTION);
    expect(runner.resolvedProvider.sdkRuntime).toBe("codex");

    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "claude-subscription";
    resetProviderConfig();
    expect(() =>
      createResumeProviderRunner({
        model: null,
        workingDir: "/repo",
        systemPrompt: null,
        continuable: true,
        sdkRuntimeEnvironment: "user",
        sdkRuntimeHome: "managedAstral",
      }, {
        provider: "codex",
        threadId: "codex-thread",
        transcriptPath: "/tmp/codex-session.jsonl",
      })
    ).toThrow(ResumeProviderMismatchError);
  });

  it("includes configured system prompts in Codex turn input", () => {
    expect(
      buildCodexTurnInput(
        {
          model: null,
          workingDir: null,
          systemPrompt: "Be concise.",
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
        "Summarize this."
      )
    ).toBe("System instructions:\nBe concise.\n\nUser request:\nSummarize this.");
  });

  it("keeps Claude SDK sessions non-persistent", () => {
    const abortController = new AbortController();
    const options = buildClaudeQueryOptions(
      {
        model: null,
        workingDir: "/tmp/work",
        systemPrompt: "System",
        continuable: false,
        sdkRuntimeEnvironment: "isolated",
      },
      {
        type: PROVIDER_TYPES.CLAUDE_SUBSCRIPTION,
        mode: "sdk",
        modelId: "claude-sonnet-4-5",
        sdkRuntime: "claude",
        costTracking: "none",
      },
      abortController,
      {}
    );

    expect(options).toMatchObject({
      cwd: "/tmp/work",
      persistSession: false,
      abortController,
    });
    expect(options).not.toHaveProperty("resume");
  });

  it("can opt Claude SDK sessions into explicit persistence and resume", () => {
    const abortController = new AbortController();
    const options = buildClaudeQueryOptions(
      {
        model: null,
        workingDir: "/tmp/work",
        systemPrompt: "System",
        continuable: true,
        sdkRuntimeEnvironment: "isolated",
      },
      {
        type: PROVIDER_TYPES.CLAUDE_SUBSCRIPTION,
        mode: "sdk",
        modelId: "claude-sonnet-4-5",
        sdkRuntime: "claude",
        costTracking: "none",
      },
      abortController,
      {},
      { persistSession: true, resume: "native-session-1" }
    );

    expect(options).toMatchObject({
      persistSession: true,
      resume: "native-session-1",
    });
  });

  it("keeps Codex UI turns read-only with approval lifecycle enabled and reasoning effort applied", () => {
    expect(
      buildCodexThreadOptions(
        {
          model: "opus",
          workingDir: "/tmp/work",
          systemPrompt: null,
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
          runtimeExecutionMode: "sdk",
        },
        {
          type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
          mode: "sdk",
          modelId: "gpt-5.5",
          reasoningEffort: "xhigh",
          sdkRuntime: "codex",
          costTracking: "none",
        }
      )
    ).toMatchObject({
      workingDirectory: "/tmp/work",
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
      modelReasoningEffort: "xhigh",
    });
  });
});
