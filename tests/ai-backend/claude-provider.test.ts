import { describe, expect, it } from "vitest";
import {
  createClaudeUiStreamState,
  mapClaudeUiStreamMessage,
  recordClaudePlanUpdate,
  sanitizeClaudeEnv,
} from "../../src/providers/claude-agent-runtime.js";

describe("AI backend Claude provider helpers", () => {
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

  it("maps thinking blocks and ExitPlanMode to generic runtime events", () => {
    const state = createClaudeUiStreamState();

    const mapped = mapClaudeUiStreamMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "tool_use", id: "tool-1", name: "ExitPlanMode", input: { plan: "Do it" } },
        ],
      },
    }, state);

    expect(mapped.events).toContainEqual({ type: "message.reasoning_delta", ref: "assistant", delta: "reasoning" });
    expect(mapped.events).toContainEqual({ type: "plan.updated", state: { mode: "awaitingApproval", planText: "Do it", approved: false } });
    expect(mapped.events).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "tool-1", name: "ExitPlanMode" }));
    expect(recordClaudePlanUpdate(state, "Do it")).toBe(false);
  });

  it("does not double emit reasoning seen in partial stream and final assistant block", () => {
    const state = createClaudeUiStreamState();

    const partial = mapClaudeUiStreamMessage({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "reasoning" },
      },
    }, state);
    const final = mapClaudeUiStreamMessage({
      type: "assistant",
      message: {
        content: [{ type: "thinking", thinking: "reasoning" }],
      },
    }, state);

    expect(partial.events).toContainEqual({ type: "message.reasoning_delta", ref: "assistant", delta: "reasoning" });
    expect(final.events).not.toContainEqual(expect.objectContaining({ type: "message.reasoning_delta" }));
  });
});
