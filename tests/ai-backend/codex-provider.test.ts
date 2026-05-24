import { describe, expect, it } from "vitest";
import {
  buildCodexConfig,
  buildCodexEnv,
  createCodexUiStreamState,
  mapCodexUiStreamEvent,
} from "../../src/providers/codex-agent-runtime.js";

describe("AI backend Codex provider helpers", () => {
  it("builds OpenRouter Codex config without forcing ChatGPT login", () => {
    const config = buildCodexConfig("isolated", "/tmp/codex-home", true);

    expect(config?.model_provider).toBe("openrouter");
    expect(config?.history).toEqual({ persistence: "none" });
    expect(config?.forced_login_method).toBeUndefined();
    expect(config?.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
  });

  it("keeps OpenRouter Codex provider routing for user runtime sessions", () => {
    const config = buildCodexConfig("user", null, true, false);

    expect(config?.model_provider).toBe("openrouter");
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
  });

  it("removes API-key env for OpenAI subscription sessions", () => {
    const env = buildCodexEnv("isolated", "/tmp/codex-home", true);

    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("uses process runtime home and config for user runtime sessions", () => {
    const previousCodexHome = process.env.CODEX_HOME;
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    const previousOpenRouterKey = process.env.OPENROUTER_API_KEY;
    try {
      process.env.CODEX_HOME = "/home/user/.codex";
      process.env.OPENAI_API_KEY = "openai-key";
      process.env.OPENROUTER_API_KEY = "openrouter-key";

      const env = buildCodexEnv("user", null, true);
      const config = buildCodexConfig("user", null, false, true);

      expect(env.CODEX_HOME).toBe("/home/user/.codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(config).toBeUndefined();
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
  });

  it("keeps file-change items running until completion", () => {
    const state = createCodexUiStreamState();
    const started = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "file-change-1",
        type: "file_change",
        status: "started",
        changes: [{ path: "src/example.ts", kind: "update" }],
      },
    }, state);
    const completed = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "file-change-1",
        type: "file_change",
        status: "completed",
        changes: [{ path: "src/example.ts", kind: "update" }],
      },
    }, state);

    expect(started).toContainEqual({ type: "tool.created", ref: "file-change-1", name: "file_edit", input: expect.any(Object) });
    expect(started).toContainEqual({ type: "tool.updated", ref: "file-change-1", status: "running" });
    expect(started).not.toContainEqual(expect.objectContaining({ type: "tool.completed" }));
    expect(completed).toContainEqual(expect.objectContaining({ type: "tool.completed", ref: "file-change-1" }));
  });
});
