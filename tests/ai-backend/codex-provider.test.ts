import { describe, expect, it } from "vitest";
import { buildCodexConfig, buildCodexEnv } from "../../src/providers/codex-agent-runtime.js";

describe("AI backend Codex provider helpers", () => {
  it("builds OpenRouter Codex config without forcing ChatGPT login", () => {
    const config = buildCodexConfig("/tmp/codex-home", true);

    expect(config.model_provider).toBe("openrouter");
    expect(config.forced_login_method).toBeUndefined();
    expect(config.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
  });

  it("removes API-key env for OpenAI subscription sessions", () => {
    const env = buildCodexEnv("/tmp/codex-home", true);

    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });
});
