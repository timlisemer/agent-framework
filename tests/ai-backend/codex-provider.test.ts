import { describe, expect, it } from "vitest";
import {
  buildCodexConfig,
  buildCodexEnv,
  buildCodexThreadOptions,
  createCodexUiStreamState,
  mapCodexUiStreamEvent,
} from "../../src/providers/codex-agent-runtime.js";
import { PROVIDER_TYPES } from "../../src/utils/provider-config.js";

describe("AI backend Codex provider helpers", () => {
  it("builds OpenRouter Codex config without forcing ChatGPT login", () => {
    const config = buildCodexConfig("isolated", "/tmp/codex-home", true);

    expect(config?.model_provider).toBe("openrouter");
    expect(config?.show_raw_agent_reasoning).toBe(true);
    expect(config?.history).toEqual({ persistence: "none" });
    expect(config?.forced_login_method).toBeUndefined();
    expect(config?.model_providers).toMatchObject({
      openrouter: { env_key: "OPENROUTER_API_KEY" },
    });
  });

  it("keeps OpenRouter Codex provider routing for user runtime sessions", () => {
    const config = buildCodexConfig("user", null, true, false);

    expect(config?.model_provider).toBe("openrouter");
    expect(config?.show_raw_agent_reasoning).toBe(true);
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
    expect(config?.show_raw_agent_reasoning).toBe(true);
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
      expect(config?.show_raw_agent_reasoning).toBe(true);
    } finally {
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      if (previousOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previousOpenRouterKey;
    }
  });

  it("keeps Codex sandbox policy isolated to isolated runtime sessions", () => {
    const isolated = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "isolated",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "sdk",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });
    const user = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "user",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "sdk",
      modelId: "gpt-5.3-codex",
      reasoningEffort: "high",
      costTracking: "none",
    });

    expect(isolated).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      sandboxMode: "read-only",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
    });
    expect(user).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      modelReasoningEffort: "high",
    });
    expect(user).not.toHaveProperty("sandboxMode");
    expect(user).not.toHaveProperty("approvalPolicy");
    expect(user).not.toHaveProperty("networkAccessEnabled");
    expect(user).not.toHaveProperty("webSearchMode");
    expect(user).not.toHaveProperty("webSearchEnabled");
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

  it("passes Codex command actions through as UI action summaries", () => {
    const state = createCodexUiStreamState();

    const events = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "rg -n ai-message-section crates/astral-shell/src/style/style.css",
        status: "in_progress",
        commandActions: [
          { type: "read", name: "message_rendering.rs", path: "/repo/crates/astral-ai-gtk/src/message_rendering.rs" },
          { type: "search", query: "ai-message-section", path: "style.css" },
          { type: "listFiles", path: "crates/astral-ai-gtk/src" },
          { type: "unknown", command: "sed -n '1,2p' file" },
        ],
      },
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "cmd-1",
      name: "shell",
      input: expect.objectContaining({
        fields: expect.objectContaining({
          actionSummary: "Read message_rendering.rs\nSearch ai-message-section in style.css\nList crates/astral-ai-gtk/src",
        }),
      }),
    }));
  });

  it("does not fabricate Codex action summaries from plain shell commands", () => {
    const state = createCodexUiStreamState();

    const events = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "cmd-plain",
        type: "command_execution",
        command: "sed -n '1,120p' src/example.ts",
        status: "in_progress",
      },
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "cmd-plain",
      name: "shell",
      input: expect.objectContaining({
        fields: expect.not.objectContaining({ actionSummary: expect.anything() }),
      }),
    }));
  });

  it("maps reasoning, todo lists, mcp identity, and unknown items to generic events", () => {
    const state = createCodexUiStreamState();

    expect(mapCodexUiStreamEvent({
      type: "item.updated",
      item: { id: "r1", type: "reasoning", text: "thinking" },
    }, state)).toEqual([
      { type: "message.created", ref: "r1", content: "" },
      { type: "message.reasoning_delta", ref: "r1", delta: "thinking" },
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

    const textDelta = firstText.find((event) => event.type === "message.delta");
    const reasoningDelta = firstReasoning.find((event) => event.type === "message.reasoning_delta");

    expect(textDelta).toMatchObject({ type: "message.delta", delta: "hel" });
    expect(secondText).toEqual([{ type: "message.delta", ref: textDelta?.ref, delta: "lo" }]);
    expect(reasoningDelta).toMatchObject({ type: "message.reasoning_delta", delta: "rea" });
    expect(secondReasoning).toEqual([{ type: "message.reasoning_delta", ref: reasoningDelta?.ref, delta: "son" }]);
  });

  it("keeps separate assistant message items as separate transcript messages", () => {
    const state = createCodexUiStreamState();

    const beforeTool = mapCodexUiStreamEvent({
      type: "item.completed",
      item: { id: "msg-1", type: "agent_message", text: "Running the command now." },
    }, state);
    const afterTool = mapCodexUiStreamEvent({
      type: "item.completed",
      item: { id: "msg-2", type: "agent_message", text: "I just ran the bash command." },
    }, state);

    expect(beforeTool).toContainEqual({ type: "message.created", ref: "msg-1", content: "" });
    expect(beforeTool).toContainEqual({ type: "message.completed", ref: "msg-1", content: "Running the command now.", usage: null });
    expect(afterTool).toContainEqual({ type: "message.created", ref: "msg-2", content: "" });
    expect(afterTool).toContainEqual({ type: "message.completed", ref: "msg-2", content: "I just ran the bash command.", usage: null });
  });

  it("maps terminal turn completion to usage without creating assistant messages", () => {
    const state = createCodexUiStreamState();

    expect(mapCodexUiStreamEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 10,
        cached_input_tokens: 2,
        output_tokens: 5,
        reasoning_output_tokens: 3,
      },
    }, state)).toEqual([{
      type: "turn.completed",
      usage: {
        promptTokens: 10,
        cachedTokens: 2,
        completionTokens: 5,
        reasoningTokens: 3,
        totalTokens: 15,
      },
    }]);
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
