import { describe, expect, it } from "vitest";
import {
  buildCodexConfig,
  buildCodexEnv,
  createCodexUiStreamState,
  mapCodexUiStreamEvent,
} from "../../src/providers/codex-agent-runtime.js";

describe("AI backend Codex provider helpers", () => {
  it("builds OpenRouter Codex config without forcing ChatGPT login", () => {
    const config = buildCodexConfig("/tmp/codex-home", true);

    expect(config.model_provider).toBe("openrouter");
    expect(config.history).toEqual({ persistence: "none" });
    expect(config.forced_login_method).toBeUndefined();
    expect(config.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
  });

  it("does not disable Codex history for continuable sessions", () => {
    const config = buildCodexConfig("/tmp/codex-home", false, true);

    expect(config.history).toBeUndefined();
    expect(config.forced_login_method).toBe("chatgpt");
  });

  it("removes API-key env for OpenAI subscription sessions", () => {
    const env = buildCodexEnv("/tmp/codex-home", true);

    expect(env.CODEX_HOME).toBe("/tmp/codex-home");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
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
