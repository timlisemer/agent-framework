import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Programmable mock for the Claude SDK `query()`. Each test installs the
// generator(s) it wants the mock to yield via `setQueryGenerators()`. The
// mock invokes the optional `stderr` callback the first time it's called per
// generator, mirroring the SDK's own behaviour where stderr can fire before
// the message stream emits anything.
type StderrCallback = ((data: string) => void) | undefined;
type QueryGenerator = (stderr: StderrCallback) => AsyncGenerator<unknown, void, unknown>;

let queryGenerators: QueryGenerator[] = [];
let queryCallCount = 0;

function setQueryGenerators(...gens: QueryGenerator[]): void {
  queryGenerators = gens;
  queryCallCount = 0;
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn().mockImplementation((args: { options?: { stderr?: (data: string) => void } }) => {
    const idx = Math.min(queryCallCount, queryGenerators.length - 1);
    const gen = queryGenerators[idx];
    queryCallCount++;
    return gen(args.options?.stderr);
  }),
}));

// Spy-able mock for the Anthropic client. `messages.create` MUST NOT be
// called when input is a sentinel — that's the contract of the format-
// validation skip-on-sentinel branch.
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

import { query as queryMock } from "@anthropic-ai/claude-agent-sdk";
import { runAgent, type AgentConfig } from "../../src/utils/agent-runner.js";
import { MODEL_TIERS } from "../../src/types.js";

const FALLBACK_TEMPLATE = "## Verdict\nDECLINED: Agent returned malformed output\n\n## Raw Output\n$RAW";

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-confirm-shape",
    tier: MODEL_TIERS.OPUS,
    mode: "sdk",
    systemPrompt: "Test system prompt",
    maxTurns: 1,
    workingDir: "/tmp",
    formatValidation: {
      validator: /## Verdict\s*\n(CONFIRMED|DECLINED)/i,
      formatReminder: "Reply with ## Verdict followed by CONFIRMED or DECLINED",
      fallbackOutput: FALLBACK_TEMPLATE,
    },
    ...overrides,
  };
}

describe("runAgent — SDK-error sentinel triggers fallbackOutput without retry", () => {
  beforeEach(() => {
    messagesCreateSpy.mockReset();
    (queryMock as unknown as { mockClear: () => void }).mockClear?.();
    setQueryGenerators();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("substitutes fallbackOutput for [SDK ERROR] sentinel and skips the retry tier", async () => {
    // Both attempts yield zero messages so the in-process retry runs once and
    // also returns the enriched sentinel — proving the fallback template is
    // applied to the second-attempt sentinel (not the first).
    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {},
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {},
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    // Output should contain the substituted fallback (NOT the raw sentinel as the entire output).
    expect(result.output).toContain("## Verdict");
    expect(result.output).toContain("DECLINED: Agent returned malformed output");
    // The sentinel should appear inside the Raw Output section as substituted $RAW,
    // proving the fallback was applied (not that the raw sentinel leaked verbatim).
    expect(result.output).toContain("## Raw Output");
    expect(result.output).toContain("[SDK ERROR] No output received");
    // The output must NOT be exactly the raw sentinel — the fallback wraps it.
    expect(result.output).not.toBe("[SDK ERROR] No output received");

    // Enriched sentinel must include zero-message diagnostics.
    expect(result.output).toContain("messages=0");
    expect(result.output).toContain("lastType=none");

    // Retry-tier loop must not have been entered for sentinel inputs.
    expect(messagesCreateSpy).not.toHaveBeenCalled();

    // Sanity: success/errorCount reflect the failure path.
    expect(result.success).toBe(false);
    expect(result.errorCount).toBeGreaterThan(0);
  });

  it("enriches sentinel with error-subtype diagnostics from result message", async () => {
    // error_during_execution is in the retry-eligible set, so two attempts
    // both yielding the same error must surface the enriched sentinel and
    // call query() exactly twice.
    const errorResult = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["upstream blip"],
      terminal_reason: "model_error",
    };
    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield errorResult;
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield errorResult;
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(result.output).toContain("## Raw Output");
    expect(result.output).toContain("[SDK ERROR] No output received");
    expect(result.output).toContain("subtype=error_during_execution");
    expect(result.output).toContain("upstream blip");
    expect(result.output).toContain("terminalReason=model_error");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("treats success+is_error=true as failure and ignores its result text", async () => {
    // success+is_error is also retry-eligible. Both attempts return the same
    // poisoned success — the result text must NEVER appear in the output.
    const poisonedSuccess = {
      type: "result",
      subtype: "success",
      is_error: true,
      result: "garbage",
    };
    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield poisonedSuccess;
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield poisonedSuccess;
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(result.output).not.toContain("garbage");
    expect(result.output).toContain("[SDK ERROR] No output received");
    expect(result.output).toContain("subtype=success");
    expect(result.output).toContain("isError=true");
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it("retries once when the first attempt yields no messages and returns the second result", async () => {
    setQueryGenerators(
      // First attempt: zero messages
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {},
      // Second attempt: a normal success result with valid Verdict text
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "## Verdict\nCONFIRMED: looks good",
        };
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(result.output).toBe("## Verdict\nCONFIRMED: looks good");
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(result.errorCount).toBe(0);
  });

  it("does not retry on error_max_turns (deterministic limit)", async () => {
    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          errors: ["max turns exhausted"],
        };
      },
      // Second generator should never be consumed — added only to make a
      // spurious second call observable if the retry guard regresses.
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "## Verdict\nCONFIRMED: should not appear",
        };
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(result.output).toContain("subtype=error_max_turns");
    expect(result.output).toContain("max turns exhausted");
    expect(result.output).not.toContain("should not appear");
  });

  it("captures stderr output in the enriched sentinel", async () => {
    setQueryGenerators(
      async function* (stderr) {
        stderr?.("spawn warning\n");
      },
      async function* (stderr) {
        stderr?.("spawn warning\n");
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(result.output).toContain("[SDK ERROR] No output received");
    expect(result.output).toContain("stderrTail=");
    expect(result.output).toContain("spawn warning");
  });

  it("does not use poisoned assistant content when assistant message has error", async () => {
    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "assistant",
          error: "rate_limit",
          message: {
            content: "partial garbage",
          },
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "assistant",
          error: "rate_limit",
          message: {
            content: "partial garbage",
          },
        };
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    expect(result.output).not.toContain("partial garbage");
    expect(result.output).toContain("[SDK ERROR] No output received");
    expect(result.output).toContain("assistantError=rate_limit");
  });

  it("extractDecision classification of the wrapped fallback envelope is unchanged by sentinel enrichment", async () => {
    // Use the real extractDecision implementation. extractDecision looks at
    // the first whitespace-delimited token of the trimmed output — the
    // fallback envelope starts with "## Verdict" so the first token is "##",
    // which is not in the recognized decision patterns. The point of this
    // regression test is to confirm that the enriched parenthetical embedded
    // inside the `## Raw Output` block does NOT shift this classification —
    // the value must be the same as what the bare-template envelope produces.
    const { extractDecision: realExtractDecision } = await vi.importActual<
      typeof import("../../src/utils/telemetry-tracker.js")
    >("../../src/utils/telemetry-tracker.js");

    setQueryGenerators(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["enrichment must not shift decision"],
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async function* (_stderr) {
        yield {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          errors: ["enrichment must not shift decision"],
        };
      },
    );

    const result = await runAgent(makeConfig(), { prompt: "Evaluate:" });

    // Decision derived from the enriched envelope.
    const enrichedDecision = realExtractDecision(result.output);

    // Decision derived from the bare fallback template (no enrichment): the
    // baseline behavior the call site at agent-runner.ts (decisionOverride
    // ?? extractDecision(...) ?? "DENY") relies on.
    const bareEnvelope = FALLBACK_TEMPLATE.replace(
      "$RAW",
      "[SDK ERROR] No output received",
    );
    const baselineDecision = realExtractDecision(bareEnvelope);

    expect(enrichedDecision).toBe(baselineDecision);

    // Sanity: the enriched sentinel really is embedded in $RAW, not leaking
    // verbatim as the entire output.
    expect(result.output.startsWith("[SDK ERROR]")).toBe(false);
    expect(result.output).toContain("## Raw Output");
    expect(result.output).toContain("subtype=error_during_execution");
  });
});
