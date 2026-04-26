import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the Claude SDK query so runSdkAgent receives no result/assistant
// messages and falls through to the "[SDK ERROR] No output received" sentinel.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation(() => {
    return (async function* () {
      // Yield nothing — runSdkAgent's for-await loop never sees a 'result'
      // or 'assistant' message, so finalResult and lastAssistantContent
      // remain empty strings and the sentinel branch fires.
    })();
  }),
}));

// Spy-able mock for the Anthropic client. `messages.create` MUST NOT be
// called when input is a sentinel — that's the contract of Change 1.
const messagesCreateSpy = vi.fn();

vi.mock("../../src/utils/anthropic-client.js", () => ({
  getAnthropicClient: vi.fn(() => ({
    messages: { create: messagesCreateSpy },
  })),
}));

// Logger is unused here but agent-runner imports it transitively.
vi.mock("../../src/utils/logger.js", () => ({
  logAgentDecision: vi.fn(),
  extractDecision: vi.fn(),
  logAgentStarted: vi.fn(),
}));

import { runAgent, type AgentConfig } from "../../src/utils/agent-runner.js";
import { MODEL_TIERS } from "../../src/types.js";

describe("runAgent — SDK-error sentinel triggers fallbackOutput without retry", () => {
  beforeEach(() => {
    messagesCreateSpy.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("substitutes fallbackOutput for [SDK ERROR] sentinel and skips the retry tier", async () => {
    const fallbackTemplate = "## Verdict\nDECLINED: Agent returned malformed output\n\n## Raw Output\n$RAW";

    const testConfig: AgentConfig = {
      name: "test-confirm-shape",
      tier: MODEL_TIERS.OPUS,
      mode: "sdk",
      systemPrompt: "Test system prompt",
      maxTurns: 1,
      workingDir: "/tmp",
      formatValidation: {
        validator: /## Verdict\s*\n(CONFIRMED|DECLINED)/i,
        formatReminder: "Reply with ## Verdict followed by CONFIRMED or DECLINED",
        fallbackOutput: fallbackTemplate,
      },
    };

    const result = await runAgent(testConfig, { prompt: "Evaluate:" });

    // Output should contain the substituted fallback (NOT the raw sentinel as the entire output).
    expect(result.output).toContain("## Verdict");
    expect(result.output).toContain("DECLINED: Agent returned malformed output");
    // The sentinel should appear inside the Raw Output section as substituted $RAW,
    // proving the fallback was applied (not that the raw sentinel leaked verbatim).
    expect(result.output).toContain("## Raw Output");
    expect(result.output).toContain("[SDK ERROR] No output received");
    // The output must NOT be exactly the raw sentinel — the fallback wraps it.
    expect(result.output).not.toBe("[SDK ERROR] No output received");

    // Retry-tier loop must not have been entered for sentinel inputs.
    expect(messagesCreateSpy).not.toHaveBeenCalled();

    // Sanity: success/errorCount reflect the failure path.
    expect(result.success).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
  });
});
