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

  it("maps reasoning, todo lists, mcp identity, and unknown items to generic events", () => {
    const state = createCodexUiStreamState();

    expect(mapCodexUiStreamEvent({
      type: "item.updated",
      item: { id: "r1", type: "reasoning", text: "thinking" },
    }, state)).toEqual([
      { type: "message.created", ref: "assistant", content: "" },
      { type: "message.reasoning_delta", ref: "assistant", delta: "thinking" },
    ]);

    expect(mapCodexUiStreamEvent({
      type: "item.updated",
      item: { id: "todos", type: "todo_list", items: [{ content: "Inspect", status: "completed" }, { content: "Patch", status: "pending" }] },
    }, state)).toContainEqual({
      type: "plan.updated",
      state: { mode: "planning", planText: "- [x] Inspect\n- [ ] Patch", approved: false },
    });

    const mcp = mapCodexUiStreamEvent({
      type: "item.started",
      item: { id: "mcp-1", type: "mcp_tool_call", server: "github", tool: "search", arguments: { query: "abc" } },
    }, state);
    expect(mcp).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "mcp-1",
      name: "mcp__github__search",
      input: expect.objectContaining({ fields: expect.objectContaining({ server: "github", tool: "search", query: "abc" }) }),
    }));

    const unknown = mapCodexUiStreamEvent({
      type: "item.completed",
      item: { id: "future-1", type: "future_item", status: "completed", value: 1 },
    }, state);
    expect(unknown).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "future-1", name: "runtime_item" }));
    expect(unknown).toContainEqual(expect.objectContaining({ type: "tool.completed", ref: "future-1" }));
  });

  it("uses stable tracking for id-less streamed assistant and reasoning items", () => {
    const state = createCodexUiStreamState();

    const firstText = mapCodexUiStreamEvent({
      type: "item.updated",
      item: { type: "agent_message", text: "hel" },
    }, state);
    const secondText = mapCodexUiStreamEvent({
      type: "item.updated",
      item: { type: "agent_message", text: "hello" },
    }, state);
    const firstReasoning = mapCodexUiStreamEvent({
      type: "item.updated",
      item: { type: "reasoning", summary: "rea" },
    }, state);
    const secondReasoning = mapCodexUiStreamEvent({
      type: "item.updated",
      item: { type: "reasoning", summary: "reason" },
    }, state);

    expect(firstText).toContainEqual({ type: "message.delta", ref: "assistant", delta: "hel" });
    expect(secondText).toEqual([{ type: "message.delta", ref: "assistant", delta: "lo" }]);
    expect(firstReasoning).toContainEqual({ type: "message.reasoning_delta", ref: "assistant", delta: "rea" });
    expect(secondReasoning).toEqual([{ type: "message.reasoning_delta", ref: "assistant", delta: "son" }]);
  });

  it("uses stable synthetic refs for id-less mutable tool items", () => {
    const state = createCodexUiStreamState();

    const started = mapCodexUiStreamEvent({
      type: "item.started",
      item: { type: "command_execution", command: "npm test", status: "in_progress", aggregated_output: "one" },
    }, state);
    const updated = mapCodexUiStreamEvent({
      type: "item.updated",
      item: { type: "command_execution", command: "npm test", status: "in_progress", aggregated_output: "one two" },
    }, state);

    expect(started.filter((event) => event.type === "tool.created")).toHaveLength(1);
    expect(updated.filter((event) => event.type === "tool.created")).toHaveLength(0);
    expect(updated).toContainEqual(expect.objectContaining({ type: "tool.progress", progress: "one two" }));
  });
});
