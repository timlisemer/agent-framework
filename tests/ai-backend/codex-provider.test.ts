import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodexConfig,
  buildCodexEnv,
  buildCodexSessionEnv,
  buildCodexThreadOptions,
  codexDirectToolUseErrorResult,
  codexTurnHasDirectForbiddenItems,
  createCodexUiStreamState,
  mapCodexUiStreamEvent,
  mapCodexToolLogEntryForUi,
  startOrResumeCodexThread,
} from "../../src/providers/codex-agent-runtime.js";
import { PROVIDER_TYPES } from "../../src/utils/provider-config.js";
import { withEnvForTest } from "../helpers/provider-env.js";

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

    expect(env.CODEX_HOME).toBe(process.env.CODEX_HOME);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
  });

  it("uses process runtime home and config for user runtime sessions", () => {
    const restoreEnv = withEnvForTest({
      CODEX_HOME: "/home/user/.codex",
      OPENAI_API_KEY: "openai-key",
      OPENROUTER_API_KEY: "openrouter-key",
    });
    try {
      const env = buildCodexEnv("user", null, true);
      const config = buildCodexConfig("user", null, false, true);

      expect(env.CODEX_HOME).toBe("/home/user/.codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(config?.show_raw_agent_reasoning).toBe(true);
    } finally {
      restoreEnv();
    }
  });

  it("scrubs API keys without overriding materialized runtime homes", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-codex-test-"));
    const restoreEnv = withEnvForTest({
      HOME: home,
      CODEX_HOME: "/native/codex",
      OPENAI_API_KEY: "openai-key",
      CODEX_API_KEY: "codex-key",
      OPENROUTER_API_KEY: "openrouter-key",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    try {
      const env = buildCodexSessionEnv("user", null, true, "managedAstral");

      expect(env.CODEX_HOME).toBe("/native/codex");
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(env.CODEX_API_KEY).toBeUndefined();
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      restoreEnv();
    }
  });

  it("requires SDK support when resuming a native Codex thread", () => {
    const startThread = vi.fn(() => ({ id: "new-thread", run: vi.fn() }));

    expect(() =>
      startOrResumeCodexThread({ startThread }, { workingDirectory: "/repo" }, "existing-thread")
    ).toThrow("Codex SDK does not support native thread resume.");
    expect(startThread).not.toHaveBeenCalled();
  });

  it("keeps Codex runtime policy separated by execution mode and runtime environment", () => {
    const direct = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "isolated",
      runtimeExecutionMode: "direct",
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "direct",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });
    const sdk = buildCodexThreadOptions({
      workingDir: "/repo",
      sdkRuntimeEnvironment: "isolated",
      runtimeExecutionMode: "sdk",
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

    expect(direct).toMatchObject({
      workingDirectory: "/repo",
      skipGitRepoCheck: true,
      model: "gpt-5.3-codex",
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      webSearchEnabled: false,
    });
    expect(sdk).toMatchObject({
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

  it("detects tool-capable Codex items as direct-mode contract violations", () => {
    for (const type of ["command_execution", "file_change", "mcp_tool_call", "web_search"]) {
      expect(codexTurnHasDirectForbiddenItems({ items: [{ type }] })).toBe(true);
    }

    expect(codexTurnHasDirectForbiddenItems({
      items: [
        { type: "agent_message" },
        { type: "reasoning" },
        { type: "todo_list" },
      ],
    })).toBe(false);
    expect(codexTurnHasDirectForbiddenItems({ finalResponse: "ok" })).toBe(false);
  });

  it("returns a direct error result when a Codex direct turn reports tool use", () => {
    const result = codexDirectToolUseErrorResult({
      finalResponse: "tool-informed answer",
      items: [{ type: "command_execution" }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, {
      type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      mode: "direct",
      modelId: "gpt-5.3-codex",
      costTracking: "none",
    });

    expect(result).toMatchObject({
      text: "[DIRECT ERROR] Direct Codex runtime attempted tool use",
      provider: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
      modelName: "gpt-5.3-codex",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    });
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

    expect(started).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "file-change-1", name: "file_edit", input: expect.any(Object) }));
    expect(started).toContainEqual({ type: "tool.updated", ref: "file-change-1", status: "running" });
    expect(started).not.toContainEqual(expect.objectContaining({ type: "tool.completed" }));
    expect(completed).toContainEqual(expect.objectContaining({ type: "tool.completed", ref: "file-change-1" }));
  });

  it("maps Codex command executions as plain shell tools", () => {
    const state = createCodexUiStreamState();

    const events = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "sed -n '1,120p' src/example.ts",
        status: "in_progress",
        commandActions: [
          { type: "read", name: "example.ts", path: "/repo/src/example.ts" },
          { type: "search", query: "needle", path: "src/example.ts" },
        ],
      },
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "cmd-1",
      name: "shell",
      input: expect.objectContaining({
        fields: expect.objectContaining({
          command: "sed -n '1,120p' src/example.ts",
          actionSummary: "Read /repo/src/example.ts\nSearch \"needle\" in src/example.ts",
          actionCount: 2,
        }),
      }),
      metadata: expect.objectContaining({
        provider: "codex",
        providerItemId: "cmd-1",
        providerItemType: "command_execution",
        actionSummary: "Read /repo/src/example.ts\nSearch \"needle\" in src/example.ts",
      }),
    }));
  });

  it("maps Codex function-call item shapes to first-class tools", () => {
    const state = createCodexUiStreamState();

    const started = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "item-1",
        type: "function_call",
        call_id: "call-read-1",
        name: "Read",
        arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
      },
    }, state);
    const completed = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "out-1",
        type: "function_call_output",
        call_id: "call-read-1",
        output: "file contents",
      },
    }, state);

    expect(started).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "call-read-1",
      name: "Read",
      input: expect.objectContaining({
        fields: expect.objectContaining({ file_path: "/repo/src/example.ts" }),
      }),
      metadata: expect.objectContaining({
        providerItemId: "call-read-1",
        providerItemType: "function_call",
        providerToolCallId: "call-read-1",
      }),
    }));
    expect(completed).toEqual([
      { type: "tool.completed", ref: "call-read-1", output: [{ type: "text", text: "file contents" }] },
    ]);
  });

  it("does not complete a function-call tool until its output item arrives", () => {
    const state = createCodexUiStreamState();

    const events = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "item-1",
        type: "function_call",
        call_id: "call-read-1",
        name: "Read",
        arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
      },
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "call-read-1",
      name: "Read",
    }));
    expect(events.some((event) => event.type === "tool.completed")).toBe(false);
  });

  it("buffers function-call output until the matching function call is seen", () => {
    const state = createCodexUiStreamState();

    const outputFirst = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "out-1",
        type: "function_call_output",
        call_id: "call-read-1",
        output: "file contents",
      },
    }, state);
    const call = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "item-1",
        type: "function_call",
        call_id: "call-read-1",
        name: "Read",
        arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
      },
    }, state);

    expect(outputFirst).toEqual([]);
    expect(call).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "call-read-1",
      name: "Read",
    }));
    expect(call).toContainEqual({ type: "tool.completed", ref: "call-read-1", output: [{ type: "text", text: "file contents" }] });
  });

  it("keeps repeated same-signature SDK command executions as separate tools", () => {
    const state = createCodexUiStreamState();
    const command = "sed -n '1,20p' src/example.ts";

    const first = mapCodexUiStreamEvent({
      type: "item.started",
      item: { id: "cmd-1", type: "command_execution", command },
    }, state);
    const second = mapCodexUiStreamEvent({
      type: "item.started",
      item: { id: "cmd-2", type: "command_execution", command },
    }, state);

    expect(first).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "cmd-1" }));
    expect(second).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "cmd-2" }));
  });

  it("keeps repeated same-signature function calls as separate tools", () => {
    const state = createCodexUiStreamState();
    const item = {
      type: "function_call",
      name: "Read",
      arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
    };

    const first = mapCodexUiStreamEvent({
      type: "item.started",
      item: { ...item, id: "item-1", call_id: "call-read-1" },
    }, state);
    const second = mapCodexUiStreamEvent({
      type: "item.started",
      item: { ...item, id: "item-2", call_id: "call-read-2" },
    }, state);

    expect(first).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "call-read-1" }));
    expect(second).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "call-read-2" }));
  });

  it("keeps repeated same-signature hook log entries as separate tools", () => {
    const state = createCodexUiStreamState();
    const entry = {
      ts: Date.now(),
      tool: "Bash",
      cmd: "pwd",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 5,
    };

    const first = mapCodexToolLogEntryForUi({ ...entry, toolUseId: "hook-bash-1" }, state);
    const second = mapCodexToolLogEntryForUi({ ...entry, toolUseId: "hook-bash-2" }, state);

    expect(first).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "hook-bash-1" }));
    expect(second).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "hook-bash-2" }));
  });

  it("does not deduplicate multi-file mutations that only share the first path", () => {
    const state = createCodexUiStreamState();

    const hookEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "apply_patch",
      toolUseId: "hook-edit-1",
      paths: ["/repo/src/a.ts", "/repo/src/b.ts"],
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 8,
    }, state);
    const sdkEvents = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "item-edit-2",
        type: "function_call",
        call_id: "call-edit-2",
        name: "apply_patch",
        arguments: "{\"file_paths\":[\"/repo/src/a.ts\",\"/repo/src/c.ts\"]}",
      },
    }, state);

    expect(hookEvents).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "hook-edit-1" }));
    expect(sdkEvents).toContainEqual(expect.objectContaining({ type: "tool.created", ref: "call-edit-2" }));
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

  it("maps live agent-framework denied hook log entries to visible tool failures", () => {
    const state = createCodexUiStreamState();

    const events = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      toolUseId: "call-denied",
      cmd: "cargo test -p astral-ai-gtk",
      status: "denied",
      gate: "blacklist",
      reason: "test command is covered by the agent-framework check MCP",
      ms: 59,
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.created",
      ref: "call-denied",
      name: "Bash",
      input: expect.objectContaining({
        fields: expect.objectContaining({
          command: "cargo test -p astral-ai-gtk",
          gate: "blacklist",
          reason: "test command is covered by the agent-framework check MCP",
        }),
      }),
      metadata: expect.objectContaining({
        provider: "codex",
        providerItemType: "agent_framework_tool_log",
        agentFrameworkHook: "PreToolUse",
        agentFrameworkRule: "blacklist",
        agentFrameworkToolName: "Bash",
        agentFrameworkToolStatus: "denied",
        agentFrameworkDecision: "deny",
        agentFrameworkToolUseId: "call-denied",
        agentFrameworkReason: "test command is covered by the agent-framework check MCP",
      }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      ref: "call-denied",
      publicMessage: "Tool denied (Bash / blacklist): test command is covered by the agent-framework check MCP",
      metadata: expect.objectContaining({
        agentFrameworkToolStatus: "denied",
      }),
    }));
  });

  it("maps failed hook log entries without denial decision metadata", () => {
    const state = createCodexUiStreamState();

    mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      toolUseId: "call-failed",
      cmd: "npm test",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 10,
    }, state);

    const events = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      status: "failed",
      gate: "system",
      reason: "exit code 1",
      ms: 120,
    }, state);

    expect(events).toContainEqual(expect.objectContaining({
      type: "tool.failed",
      ref: "call-failed",
      publicMessage: "Tool failed (Bash / system): exit code 1",
      metadata: expect.objectContaining({
        agentFrameworkHook: "PostToolUseFailure",
        agentFrameworkToolStatus: "failed",
      }),
    }));
    const failed = events.find((event) => event.type === "tool.failed");
    expect(failed && "metadata" in failed ? failed.metadata?.agentFrameworkDecision : undefined).toBeUndefined();
  });

  it("deduplicates hook-created tools when the Codex SDK later streams the same item", () => {
    const state = createCodexUiStreamState();

    const hookEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      toolUseId: "call-shell",
      cmd: "sed -n '1,120p' src/example.ts",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 12,
    }, state);
    const sdkEvents = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "cmd-1",
        type: "command_execution",
        command: "sed -n '1,120p' src/example.ts",
        status: "in_progress",
      },
    }, state);

    expect(hookEvents.filter((event) => event.type === "tool.created")).toHaveLength(1);
    expect(hookEvents).toContainEqual({ type: "tool.updated", ref: "call-shell", status: "running" });
    expect(sdkEvents.filter((event) => event.type === "tool.created")).toHaveLength(0);
    expect(sdkEvents).toContainEqual({ type: "tool.updated", ref: "call-shell", status: "running" });
  });

  it("deduplicates hook-created MCP tools when the SDK streams completed arguments", () => {
    const state = createCodexUiStreamState();

    const hookEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "mcp__agent_framework__check",
      toolUseId: "call-check",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 56_000,
    }, state);
    const sdkEvents = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "mcp-check-1",
        type: "mcp_tool_call",
        server: "agent_framework",
        tool: "check",
        status: "completed",
        arguments: { working_dir: "/home/tim/Coding/public_repos/agent-framework" },
        result: [{ text: "## Results\n- Errors: 0" }],
      },
    }, state);

    expect(hookEvents.filter((event) => event.type === "tool.created")).toHaveLength(1);
    expect(sdkEvents.filter((event) => event.type === "tool.created")).toHaveLength(0);
    expect(sdkEvents).toEqual([
      {
        type: "tool.completed",
        ref: "call-check",
        output: [{ type: "text", text: "## Results\n- Errors: 0" }],
      },
    ]);
  });

  it("deduplicates hook-created Read tools when Codex streams function-call items", () => {
    const state = createCodexUiStreamState();

    const hookEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Read",
      toolUseId: "hook-read-1",
      path: "/repo/src/example.ts",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 8,
    }, state);
    const sdkStarted = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "item-read-1",
        type: "function_call",
        call_id: "call-read-1",
        name: "Read",
        arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
      },
    }, state);
    const sdkCompleted = mapCodexUiStreamEvent({
      type: "item.completed",
      item: {
        id: "output-read-1",
        type: "function_call_output",
        call_id: "call-read-1",
        output: "file contents",
      },
    }, state);

    expect(hookEvents.filter((event) => event.type === "tool.created")).toHaveLength(1);
    expect(sdkStarted.filter((event) => event.type === "tool.created")).toHaveLength(0);
    expect(sdkStarted).toContainEqual({ type: "tool.updated", ref: "hook-read-1", status: "running" });
    expect(sdkCompleted).toEqual([
      { type: "tool.completed", ref: "hook-read-1", output: [{ type: "text", text: "file contents" }] },
    ]);
  });

  it("deduplicates SDK items after a post-tool-use log completed the hook tool", () => {
    const state = createCodexUiStreamState();

    const hookEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Read",
      toolUseId: "hook-read-1",
      path: "/repo/src/example.ts",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 8,
    }, state);
    const postEvents = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Read",
      path: "/repo/src/example.ts",
      status: "allowed",
      gate: "post-tool-use",
      ms: 4,
    }, state);
    const sdkStarted = mapCodexUiStreamEvent({
      type: "item.started",
      item: {
        id: "item-read-1",
        type: "function_call",
        call_id: "call-read-1",
        name: "Read",
        arguments: "{\"file_path\":\"/repo/src/example.ts\"}",
      },
    }, state);

    expect(hookEvents.filter((event) => event.type === "tool.created")).toHaveLength(1);
    expect(postEvents).toEqual([{ type: "tool.completed", ref: "hook-read-1", output: [] }]);
    expect(sdkStarted.filter((event) => event.type === "tool.created")).toHaveLength(0);
    expect(sdkStarted).toEqual([]);
  });

  it("maps non-function SDK completions to completed hook-created tools", () => {
    const cases = [
      {
        allowed: {
          ts: Date.now(),
          tool: "Bash",
          toolUseId: "hook-shell",
          cmd: "wc -c .env",
          status: "allowed",
          gate: "all-rules",
          reason: "All checks passed",
          ms: 12,
        },
        completed: {
          ts: Date.now(),
          tool: "Bash",
          cmd: "wc -c .env",
          status: "allowed",
          gate: "post-tool-use",
          ms: 0,
        },
        sdk: {
          type: "item.started",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "wc -c .env",
            status: "completed",
            aggregated_output: "3 .env",
          },
        },
        output: [{ type: "text", text: "3 .env" }],
      },
      {
        allowed: {
          ts: Date.now(),
          tool: "mcp__agent_framework__check",
          toolUseId: "hook-check",
          status: "allowed",
          gate: "all-rules",
          reason: "All checks passed",
          ms: 12,
        },
        completed: {
          ts: Date.now(),
          tool: "mcp__agent_framework__check",
          status: "allowed",
          gate: "post-tool-use",
          ms: 0,
        },
        sdk: {
          type: "item.completed",
          item: {
            id: "mcp-check-1",
            type: "mcp_tool_call",
            server: "agent_framework",
            tool: "check",
            status: "completed",
            arguments: {},
            result: [{ text: "ok" }],
          },
        },
        output: [{ type: "text", text: "ok" }],
      },
      {
        allowed: {
          ts: Date.now(),
          tool: "apply_patch",
          toolUseId: "hook-edit",
          paths: ["/repo/src/a.ts"],
          status: "allowed",
          gate: "all-rules",
          reason: "All checks passed",
          ms: 12,
        },
        completed: {
          ts: Date.now(),
          tool: "apply_patch",
          paths: ["/repo/src/a.ts"],
          status: "allowed",
          gate: "post-tool-use",
          ms: 0,
        },
        sdk: {
          type: "item.started",
          item: {
            id: "file-change-1",
            type: "file_change",
            status: "completed",
            changes: [{ path: "/repo/src/a.ts" }],
          },
        },
        output: [{ type: "json", value: { path: "/repo/src/a.ts" } }],
      },
    ];

    for (const scenario of cases) {
      const state = createCodexUiStreamState();
      mapCodexToolLogEntryForUi(scenario.allowed, state);
      expect(mapCodexToolLogEntryForUi(scenario.completed, state)).toEqual([
        { type: "tool.completed", ref: scenario.allowed.toolUseId, output: [] },
      ]);
      expect(mapCodexUiStreamEvent(scenario.sdk, state)).toEqual([
        { type: "tool.completed", ref: scenario.allowed.toolUseId, output: scenario.output },
      ]);
    }
  });

  it("completes hook-created tools from post-tool-use log entries when no SDK item follows", () => {
    const state = createCodexUiStreamState();

    mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      toolUseId: "call-shell",
      cmd: "wc -c .env",
      status: "allowed",
      gate: "all-rules",
      reason: "All checks passed",
      ms: 12,
    }, state);
    const completed = mapCodexToolLogEntryForUi({
      ts: Date.now(),
      tool: "Bash",
      cmd: "wc -c .env",
      status: "allowed",
      gate: "post-tool-use",
      ms: 0,
    }, state);

    expect(completed).toEqual([{ type: "tool.completed", ref: "call-shell", output: [] }]);
  });
});
