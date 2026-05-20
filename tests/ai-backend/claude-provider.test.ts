import { describe, expect, it } from "vitest";
import { sanitizeClaudeEnv } from "../../src/providers/claude-agent-runtime.js";

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
});
