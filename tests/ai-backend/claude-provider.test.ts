import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveClaudeTranscriptBinding,
  sanitizeClaudeEnv,
} from "../../src/providers/claude-agent-runtime.js";
import { normalizeClaudeAiUsage } from "../../adapters/claude/usage.js";
import {
  createClaudeControlStreamState,
  claudePlanUpdateForTool,
  mapClaudeControlStreamMessage,
  recordClaudePlanUpdate,
} from "../../adapters/claude/provider-events.js";
import { withTemporaryTestRootSync } from "../helpers/temporary-root.js";

describe("AI backend Claude provider helpers", () => {
  it.each(["approve", "deny"])("publishes an ExitPlanMode update once before a %s decision", () => {
    const state = createClaudeControlStreamState();
    expect(claudePlanUpdateForTool(state, "ExitPlanMode", { plan: "Decide once" })).toMatchObject({
      type: "planStateChanged",
    });
    expect(claudePlanUpdateForTool(state, "ExitPlanMode", { plan: "Decide once" })).toBeNull();
  });
  it("maps OpenRouter credentials to Anthropic-compatible Claude env", () => {
    const env = sanitizeClaudeEnv({ OPENROUTER_API_KEY: "key" }, false);

    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("key");
    expect(env.ANTHROPIC_API_KEY).toBe("");
  });

  it("removes API-key env for Claude subscription sessions", () => {
    const env = sanitizeClaudeEnv(
      {
        ANTHROPIC_API_KEY: "anthropic",
        ANTHROPIC_AUTH_TOKEN: "token",
        ANTHROPIC_BASE_URL: "url",
        OPENROUTER_API_KEY: "openrouter",
      },
      true
    );

    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("maps Claude SDK messages to control events without visible transcript rows", () => {
    const state = createClaudeControlStreamState();

    const mapped = mapClaudeControlStreamMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "tool_use", id: "tool-1", name: "ExitPlanMode", input: { plan: "Do it" } },
        ],
      },
    }, state);

    expect(mapped.events).toEqual([
      {
        type: "planStateChanged",
        data: { mode: "awaitingApproval", planText: "Do it", approved: false },
      },
    ]);
    expect(recordClaudePlanUpdate(state, "Do it")).toBe(false);
  });

  it("ignores Claude SDK system task messages in the control stream", () => {
    const state = createClaudeControlStreamState();

    const mapped = mapClaudeControlStreamMessage({
      type: "system",
      subtype: "task_started",
      task_id: "task-1",
      description: "Background work",
    }, state);

    expect(mapped.events).toEqual([]);
    expect(mapped.terminal).toBe(false);
  });

  it("maps result usage without creating a transcript message", () => {
    const state = createClaudeControlStreamState("native-1");

    const mapped = mapClaudeControlStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "native-1",
      usage: {
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 3,
      },
    }, state);

    expect(mapped.terminal).toBe(true);
    expect(mapped.usage).toEqual({
      promptTokens: 10,
      cachedTokens: 3,
      completionTokens: 4,
      reasoningTokens: null,
      totalTokens: 14,
    });
    expect(mapped.events).toEqual([]);
    expect(normalizeClaudeAiUsage(null)).toBeNull();
    expect(normalizeClaudeAiUsage({}, {
      "claude-sonnet": { cacheReadInputTokens: 7 },
      "claude-haiku": { cacheReadInputTokens: 2 },
    })).toMatchObject({ cachedTokens: 9 });
  });

  it("maps gateway cache usage from per-model totals when direct usage omits it", () => {
    const mapped = mapClaudeControlStreamMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      usage: { input_tokens: 12, output_tokens: 5 },
      modelUsage: {
        "claude-sonnet": { cacheReadInputTokens: 8 },
        "claude-haiku": { cacheReadInputTokens: 3 },
      },
    }, createClaudeControlStreamState());

    expect(mapped.usage).toEqual({
      promptTokens: 12,
      cachedTokens: 11,
      completionTokens: 5,
      reasoningTokens: null,
      totalTokens: 17,
    });
  });

  it.each([
    ["error_during_execution", false, ["tool process exited unexpectedly"]],
    ["error_max_turns", false, []],
    ["error_max_budget_usd", false, []],
    ["error_max_structured_output_retries", false, []],
    ["success", true, []],
    ["success", false, ["success result carried an SDK error"]],
  ])("maps an erroneous Claude %s result to a fatal runtime error", (subtype, isError, errors) => {
    const mapped = mapClaudeControlStreamMessage({
      type: "result",
      subtype,
      is_error: isError,
      errors,
      usage: { input_tokens: 2, output_tokens: 1 },
    }, createClaudeControlStreamState());

    expect(mapped).toMatchObject({
      terminal: true,
      events: [{
        type: "runtimeErrorObserved",
        data: {
          code: "runtime_error",
          recoverable: false,
          metadata: { claudeResultSubtype: subtype, errors },
        },
      }],
    });
  });

  it("resolves a Claude transcript by native session id under a runtime home", () => {
    withTemporaryTestRootSync("agent-framework-claude-binding-", (home) => {
      const transcriptPath = path.join(home, "projects", "repo", "session.jsonl");
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        type: "assistant",
        session_id: "native-1",
        cwd: "/repo",
        message: { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      })}\n`);

      expect(resolveClaudeTranscriptBinding({
        runtimeHomeRoot: home,
        sessionId: "native-1",
        workingDir: "/repo",
      })).toBe(transcriptPath);
    });
  });
});
