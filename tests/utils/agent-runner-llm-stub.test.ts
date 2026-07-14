import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearProviderEnvForTest, withEnvForTest } from "../helpers/provider-env.js";

// Spy that should NEVER be called when AGENT_FRAMEWORK_LLM_STUBS targets the
// telemetry agent. The stub must short-circuit at runAgentWithRetryAndTelemetry
// before reaching runAgent / runAgentWithRetry.
const queryMock = vi.fn();

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

const runAnthropicApiSkinDirectSpy = vi.fn();

vi.mock("../../src/providers/anthropic-api-skin.js", () => ({
  runAnthropicApiSkinDirect: (...args: unknown[]) => runAnthropicApiSkinDirectSpy(...args),
}));

const logAgentStartedSpy = vi.fn();
const logAgentDecisionSpy = vi.fn();

vi.mock("../../src/utils/logger.js", () => ({
  logAgentDecision: (...args: unknown[]) => logAgentDecisionSpy(...args),
  logAgentStarted: (...args: unknown[]) => logAgentStartedSpy(...args),
  extractDecision: (output: string) => {
    const t = output.trim();
    if (t.startsWith("APPROVE") || t === "OVERTURN: APPROVE") return "APPROVE";
    if (t.startsWith("DENY") || t === "UPHOLD") return "DENY";
    return null;
  },
}));

import { MODEL_TIERS, EXECUTION_TYPES } from "../../src/types.js";
import type { AgentConfig } from "../../src/utils/agent-runner.js";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "tool-appeal",
    tier: MODEL_TIERS.HAIKU,
    mode: "direct",
    systemPrompt: "Test",
    maxTokens: 100,
    ...overrides,
  };
}

const baseTelemetry = {
  agent: "tool-appeal",
  hookName: "PreToolUse",
  toolName: "Bash",
  workingDir: "/tmp",
  executionType: EXECUTION_TYPES.LLM,
};

describe("runAgentWithRetryAndTelemetry - env-keyed LLM stub", () => {
  let restoreProviderEnv: (() => void) | undefined;

  beforeEach(() => {
    restoreProviderEnv = clearProviderEnvForTest();
    queryMock.mockReset();
    runAnthropicApiSkinDirectSpy.mockReset();
    logAgentStartedSpy.mockReset();
    logAgentDecisionSpy.mockReset();
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    process.env.AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME = "claude";
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    restoreProviderEnv?.();
    restoreProviderEnv = undefined;
  });

  it("stubs tool-appeal output, never calls runAgent / runAgentWithRetry", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({
      "tool-appeal": "UPHOLD",
    });

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    const result = await runAgentWithRetryAndTelemetry(
      makeConfig(),
      { prompt: "Evaluate:" },
      {
        formatValidator: () => true,
        formatReminder: "Reply UPHOLD or OVERTURN.",
        context: "tool-appeal",
      },
      baseTelemetry,
    );

    expect(result.output).toBe("UPHOLD");
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
    expect(result.modelName).toBe("stub");
    expect(queryMock).not.toHaveBeenCalled();
    expect(runAnthropicApiSkinDirectSpy).not.toHaveBeenCalled();
  });

  it("stubs rule-gate DENY output and synthesizes correct shape", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({
      "rule-gate": "DENY: tool-approve: nope",
    });

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    const result = await runAgentWithRetryAndTelemetry(
      makeConfig({ name: "rule-gate" }),
      { prompt: "Evaluate:" },
      {
        formatValidator: () => true,
        formatReminder: "Reply APPROVE or DENY.",
        context: "rule-gate",
      },
      { ...baseTelemetry, agent: "rule-gate" },
    );

    expect(result.output).toBe("DENY: tool-approve: nope");
    expect(result.success).toBe(true);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("control: env unset reaches runAgent path (queryMock called)", async () => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;

    queryMock.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "UPHOLD",
      };
    });

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    const result = await runAgentWithRetryAndTelemetry(
      makeConfig({ mode: "sdk", workingDir: "/tmp" }),
      { prompt: "Evaluate:" },
      {
        formatValidator: () => true,
        formatReminder: "Reply UPHOLD or OVERTURN.",
        context: "tool-appeal",
      },
      baseTelemetry,
    );

    expect(queryMock).toHaveBeenCalled();
    expect(result.modelName).not.toBe("stub");
    expect(queryMock.mock.calls[0]?.[0]?.options?.persistSession).toBe(false);
  });

  it("continuable SDK sessions pass Claude resume only after the first turn", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-claude-continuable-"));
    const restoreHome = withEnvForTest({ HOME: home });
    let callCount = 0;
    queryMock.mockImplementation(async function* () {
      callCount++;
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: `turn-${callCount}`,
        session_id: `native-${callCount}`,
      };
    });

    const { createContinuableAgentSession } = await import(
      "../../src/utils/agent-runner.js"
    );
    const session = createContinuableAgentSession(
      makeConfig({ mode: "sdk", workingDir: "/tmp", continuable: true })
    );

    try {
      await session.run({ prompt: "First" });
      await session.run({ prompt: "Second" });

      expect(queryMock).toHaveBeenCalledTimes(2);
      expect(queryMock.mock.calls[0]?.[0]?.options).toMatchObject({
        persistSession: true,
      });
      expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty("resume");
      expect(queryMock.mock.calls[1]?.[0]?.options).toMatchObject({
        persistSession: true,
        resume: "native-1",
      });

      const firstHome = queryMock.mock.calls[0]?.[0]?.options?.env?.CLAUDE_CONFIG_DIR;
      const secondHome = queryMock.mock.calls[1]?.[0]?.options?.env?.CLAUDE_CONFIG_DIR;
      expect(typeof firstHome).toBe("string");
      expect(secondHome).toBe(firstHome);
      expect(fs.existsSync(firstHome as string)).toBe(true);

      await session.dispose();
      expect(fs.existsSync(firstHome as string)).toBe(false);
    } finally {
      await session.dispose();
      restoreHome();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("runAgent remains one-shot even when config continuable is true", async () => {
    queryMock.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "UPHOLD",
        session_id: "native-one-shot",
      };
    });

    const { runAgent } = await import("../../src/utils/agent-runner.js");

    await runAgent(
      makeConfig({ mode: "sdk", workingDir: "/tmp", continuable: true }),
      { prompt: "Evaluate:" }
    );

    expect(queryMock.mock.calls[0]?.[0]?.options).toMatchObject({
      persistSession: false,
    });
    expect(queryMock.mock.calls[0]?.[0]?.options).not.toHaveProperty("resume");
  });

  it("runAgent keeps direct and SDK provider boundaries separate", async () => {
    const runProviderDirectSpy = vi.fn(async (_input: unknown) => ({
      text: "direct-result",
      provider: "openrouter",
      modelName: "direct-model",
    }));
    const runProviderSdkSpy = vi.fn(async (_input: unknown) => ({
      text: "sdk-result",
      provider: "openrouter",
      modelName: "sdk-model",
    }));

    vi.doMock("../../src/providers/index.js", () => ({
      runProviderDirect: (input: unknown) => runProviderDirectSpy(input),
      runProviderSdk: (input: unknown) => runProviderSdkSpy(input),
    }));

    try {
      const { runAgent } = await import("../../src/utils/agent-runner.js");

      await runAgent(makeConfig({ mode: "direct" }), { prompt: "Summarize:" });
      await runAgent(
        makeConfig({ mode: "sdk", workingDir: "/tmp" }),
        { prompt: "Investigate:" }
      );

      expect(runProviderDirectSpy).toHaveBeenCalledTimes(1);
      expect(runProviderSdkSpy).toHaveBeenCalledTimes(1);
      expect(runProviderDirectSpy.mock.calls[0]?.[0]).toMatchObject({
        config: {
          mode: "direct",
          continuable: false,
          sdkRuntimeEnvironment: "isolated",
        },
      });
      expect(runProviderDirectSpy.mock.calls[0]?.[0]).not.toHaveProperty("tools");
      expect(runProviderSdkSpy.mock.calls[0]?.[0]).toMatchObject({
        config: {
          mode: "sdk",
          sdkRuntimeEnvironment: "isolated",
        },
        tools: ["Read", "Bash"],
      });
    } finally {
      vi.doUnmock("../../src/providers/index.js");
    }
  });

  it("malformed JSON in env throws descriptive error", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = "{not valid json";

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    await expect(
      runAgentWithRetryAndTelemetry(
        makeConfig(),
        { prompt: "Evaluate:" },
        {
          formatValidator: () => true,
          formatReminder: "Reply UPHOLD or OVERTURN.",
          context: "tool-appeal",
        },
        baseTelemetry,
      ),
    ).rejects.toThrow(/AGENT_FRAMEWORK_LLM_STUBS is not valid JSON/);
  });

  it("stub key not matching telemetry.agent falls through to LLM call", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({
      "different-agent": "UPHOLD",
    });

    queryMock.mockImplementation(async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "UPHOLD",
      };
    });

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    const result = await runAgentWithRetryAndTelemetry(
      makeConfig({ mode: "sdk", workingDir: "/tmp" }),
      { prompt: "Evaluate:" },
      {
        formatValidator: () => true,
        formatReminder: "Reply UPHOLD or OVERTURN.",
        context: "tool-appeal",
      },
      baseTelemetry,
    );

    expect(queryMock).toHaveBeenCalled();
    expect(result.modelName).not.toBe("stub");
  });

  it("telemetry side effects fire on the stub path", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({
      "tool-appeal": "UPHOLD",
    });

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    await runAgentWithRetryAndTelemetry(
      makeConfig(),
      { prompt: "Evaluate:" },
      {
        formatValidator: () => true,
        formatReminder: "Reply UPHOLD or OVERTURN.",
        context: "tool-appeal",
      },
      baseTelemetry,
    );

    expect(logAgentStartedSpy).toHaveBeenCalled();
    expect(logAgentDecisionSpy).toHaveBeenCalled();
  });

  it("rejects array-shaped JSON in env (must be object)", async () => {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = "[\"UPHOLD\"]";

    const { runAgentWithRetryAndTelemetry } = await import(
      "../../src/utils/agent-runner.js"
    );

    await expect(
      runAgentWithRetryAndTelemetry(
        makeConfig(),
        { prompt: "Evaluate:" },
        {
          formatValidator: () => true,
          formatReminder: "Reply UPHOLD or OVERTURN.",
          context: "tool-appeal",
        },
        baseTelemetry,
      ),
    ).rejects.toThrow(/must be a JSON object/);
  });
});
