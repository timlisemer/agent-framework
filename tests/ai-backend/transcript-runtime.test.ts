import { describe, expect, it } from "vitest";
import { projectTranscriptLines } from "../../src/ai-backend/transcript-runtime.js";

describe("transcript runtime projection", () => {
  it("collapses paired Codex assistant rows and normalizes wrapped user input", () => {
    const wrapped = "System instructions:\nBe brief.\n\nUser request:\nShow status";
    const projection = projectTranscriptLines({
      adapterName: "codex",
      transcriptPath: "/tmp/codex-paired.jsonl",
      rawLines: [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: { cwd: "/tmp/project", id: "thread-1" },
        }),
        JSON.stringify({
          timestamp: "2026-06-20T10:01:00.000Z",
          payload: { type: "message", role: "user", content: wrapped },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-20T10:02:00.000Z",
          payload: { type: "agent_message", message: "Status is clean." },
        }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-06-20T10:02:01.000Z",
          payload: { type: "token_count", total_token_usage: { input_tokens: 1, output_tokens: 1 } },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:02:02.000Z",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Status is clean." }],
          },
        }),
      ],
    });

    expect(projection.transcript.map((entry) => ({
      sequenceId: entry.sequenceId,
      role: entry.role,
      text: entry.content[0]?.type === "text" ? entry.content[0].text : "",
    }))).toEqual([
      { sequenceId: 1, role: "user", text: "Show status" },
      { sequenceId: 2, role: "assistant", text: "Status is clean." },
    ]);
    expect(projection.transcript[0].metadata).toMatchObject({
      agentFrameworkWrappedInput: wrapped,
      agentFrameworkSourceLine: 2,
    });
    expect(projection.transcript[1].metadata).toMatchObject({
      agentFrameworkSourceLine: 3,
      agentFrameworkSourceEndLine: 5,
    });
    expect(projection.transcript[1].usage).toEqual({
      promptTokens: 1,
      cachedTokens: null,
      completionTokens: 1,
      reasoningTokens: null,
      totalTokens: 2,
    });
    expect(projection.providerPatch.usage).toEqual(projection.transcript[1].usage);
  });

  it("keeps same-text assistant turns distinct across user boundaries", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({ payload: { role: "user", text: "First" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Repeated" } }),
        JSON.stringify({ payload: { role: "user", text: "Again" } }),
        JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Repeated" } }),
      ],
    });

    expect(projection.transcript.map((entry) => ({
      id: entry.id,
      sequenceId: entry.sequenceId,
      role: entry.role,
      text: entry.content[0]?.type === "text" ? entry.content[0].text : "",
    }))).toEqual([
      { id: expect.any(String), sequenceId: 1, role: "user", text: "First" },
      { id: expect.any(String), sequenceId: 2, role: "assistant", text: "Repeated" },
      { id: expect.any(String), sequenceId: 3, role: "user", text: "Again" },
      { id: expect.any(String), sequenceId: 4, role: "assistant", text: "Repeated" },
    ]);
    expect(projection.transcript[1].id).not.toBe(projection.transcript[3].id);
  });

  it("marks provider instruction user rows as synthetic messages", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          payload: {
            type: "message",
            role: "user",
            content: "# AGENTS.md instructions for /tmp/project\n\n<INSTRUCTIONS>\nUse rg.\n</INSTRUCTIONS>",
          },
        }),
      ],
    });

    expect(projection.transcript).toHaveLength(1);
    expect(projection.transcript[0]).toMatchObject({
      role: "user",
      status: "completed",
      metadata: {
        agentFrameworkMessageKind: "synthetic",
        agentFrameworkSyntheticSource: "provider-instructions",
      },
    });
  });

  it("marks environment context user rows as synthetic messages", () => {
    const environmentContext = [
      "<environment_context>",
      "  <current_date>2026-06-27</current_date>",
      "  <timezone>Europe/Berlin</timezone>",
      "</environment_context>",
    ].join("\n");
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          payload: {
            type: "message",
            role: "user",
            content: environmentContext,
          },
        }),
      ],
    });

    expect(projection.transcript).toEqual([
      expect.objectContaining({
        role: "user",
        status: "completed",
        content: [{ type: "text", text: environmentContext }],
        metadata: expect.objectContaining({
          agentFrameworkMessageKind: "synthetic",
          agentFrameworkSyntheticSource: "environment-context",
        }),
      }),
    ]);
  });

  it("keeps adapter meta user rows visible as synthetic messages", () => {
    const projection = projectTranscriptLines({
      adapterName: "claude",
      rawLines: [
        JSON.stringify({
          isMeta: true,
          message: {
            role: "user",
            content: "<hook_prompt hook_run_id=\"stop:1\">feedback</hook_prompt>",
          },
        }),
      ],
    });

    expect(projection.transcript).toEqual([
      expect.objectContaining({
        role: "user",
        status: "completed",
        content: [{ type: "text", text: "<hook_prompt hook_run_id=\"stop:1\">feedback</hook_prompt>" }],
        metadata: expect.objectContaining({
          agentFrameworkMessageKind: "synthetic",
          agentFrameworkSyntheticSource: "adapter-meta",
        }),
      }),
    ]);
  });

  it("collapses Claude assistant_split rows that share a message id", () => {
    const projection = projectTranscriptLines({
      adapterName: "claude",
      transcriptPath: "/tmp/claude-split.jsonl",
      rawLines: [
        JSON.stringify({
          uuid: "uuid-split-1",
          timestamp: "2026-06-20T10:00:00.000Z",
          type: "assistant",
          message: {
            id: "msg-split",
            role: "assistant",
            content: [{ type: "text", text: "First part." }],
          },
        }),
        JSON.stringify({
          uuid: "uuid-split-2",
          timestamp: "2026-06-20T10:00:01.000Z",
          type: "assistant",
          message: {
            id: "msg-split",
            role: "assistant",
            content: [
              { type: "text", text: "Second part." },
              { type: "tool_use", id: "tool-split", name: "Read", input: { file_path: "README.md" } },
            ],
          },
        }),
      ],
    });

    expect(projection.transcript).toEqual([
      expect.objectContaining({
        id: "message-msg-split",
        sequenceId: 1,
        role: "assistant",
        content: [{ type: "text", text: "First part.\nSecond part." }],
        metadata: expect.objectContaining({
          agentFrameworkSourceLine: 1,
          agentFrameworkSourceEndLine: 2,
        }),
      }),
    ]);
    expect(new Set(projection.transcript.map((entry) => entry.id)).size).toBe(projection.transcript.length);
    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-split",
        sequenceId: 2,
        turnId: projection.transcript[0].turnId,
        name: "Read",
      }),
    ]);
  });

  it("preserves JSON and object tool result output blocks", () => {
    const projection = projectTranscriptLines({
      adapterName: "claude",
      rawLines: [
        JSON.stringify({
          timestamp: "2026-06-20T10:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-array", name: "Read", input: { file_path: "result.json" } },
              { type: "tool_use", id: "tool-object", name: "Fetch", input: { url: "https://example.test" } },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-20T10:00:01.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-array",
                content: [
                  { type: "text", text: "stdout" },
                  { type: "json", value: { ok: true } },
                ],
              },
              {
                type: "tool_result",
                tool_use_id: "tool-object",
                content: { status: 200, body: { ok: true } },
              },
            ],
          },
        }),
      ],
    });

    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-array",
        status: "completed",
        output: [
          { type: "text", text: "stdout" },
          { type: "json", value: { ok: true } },
        ],
        result: expect.objectContaining({
          output: [
            { type: "text", text: "stdout" },
            { type: "json", value: { ok: true } },
          ],
        }),
      }),
      expect.objectContaining({
        id: "tool-object",
        status: "completed",
        output: [
          { type: "json", value: { status: 200, body: { ok: true } } },
        ],
        result: expect.objectContaining({
          output: [
            { type: "json", value: { status: 200, body: { ok: true } } },
          ],
        }),
      }),
    ]);
  });

  it("attaches error details to failed tool result projections", () => {
    const projection = projectTranscriptLines({
      adapterName: "claude",
      rawLines: [
        JSON.stringify({
          timestamp: "2026-06-20T10:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              { type: "tool_use", id: "tool-failed", name: "Bash", input: { command: "false" } },
            ],
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-20T10:00:01.000Z",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tool-failed",
                is_error: true,
                content: [
                  { type: "text", text: "Command failed with exit code 1" },
                ],
              },
            ],
          },
        }),
      ],
    });

    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "tool-failed",
        status: "failed",
        result: {
          state: "failed",
          output: [{ type: "text", text: "Command failed with exit code 1" }],
          error: {
            code: "runtime_error",
            message: "Command failed with exit code 1",
            recoverable: false,
          },
        },
      }),
    ]);
  });

  it("preserves structured Codex function call output as JSON blocks", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "call-json",
            name: "exec_command",
            arguments: { command: "printf json" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:01.000Z",
          payload: {
            type: "function_call_output",
            call_id: "call-json",
            output: { status: "ok", files: ["src/app.ts"] },
          },
        }),
      ],
    });

    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-json",
        status: "completed",
        output: [{ type: "json", value: { status: "ok", files: ["src/app.ts"] } }],
        result: expect.objectContaining({
          output: [{ type: "json", value: { status: "ok", files: ["src/app.ts"] } }],
        }),
      }),
    ]);
  });

  it("projects Codex function call output errors as failed tools", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "call-error",
            name: "exec_command",
            arguments: { command: "false" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:01.000Z",
          payload: {
            type: "function_call_output",
            call_id: "call-error",
            error: "Command failed with exit code 1",
          },
        }),
      ],
    });

    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-error",
        status: "failed",
        output: [{ type: "text", text: "Command failed with exit code 1" }],
        result: {
          state: "failed",
          output: [{ type: "text", text: "Command failed with exit code 1" }],
          error: {
            code: "runtime_error",
            message: "Command failed with exit code 1",
            recoverable: false,
          },
        },
      }),
    ]);
  });

  it("does not hydrate ambiguous pathless Codex tool logs by same name alone", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "call-check-1",
            name: "mcp__agent_framework__check",
            arguments: { working_dir: "/repo/a" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:01.000Z",
          payload: {
            type: "function_call",
            call_id: "call-check-2",
            name: "mcp__agent_framework__check",
            arguments: { working_dir: "/repo/b" },
          },
        }),
      ],
      toolLogEntries: [{
        ts: 1,
        tool: "mcp__agent_framework__check",
        status: "denied",
        gate: "test",
        reason: "blocked",
        ms: 1,
      }],
    });

    expect(projection.toolCalls.map((tool) => ({
      id: tool.id,
      status: tool.status,
      toolStatus: tool.metadata?.agentFrameworkToolStatus,
      toolUseId: tool.metadata?.agentFrameworkToolUseId,
    }))).toEqual([
      { id: "call-check-1", status: "running", toolStatus: undefined, toolUseId: undefined },
      { id: "call-check-2", status: "running", toolStatus: undefined, toolUseId: undefined },
    ]);
  });

  it("hydrates unique Codex command tool logs without native ids", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "call-command",
            name: "exec_command",
            arguments: { command: "npm test -- --runInBand" },
          },
        }),
      ],
      toolLogEntries: [{
        ts: 1,
        tool: "Bash",
        cmd: "npm test -- --runInBand",
        status: "denied",
        gate: "test",
        reason: "blocked",
        ms: 1,
      }],
    });

    expect(projection.toolCalls).toEqual([
      expect.objectContaining({
        id: "call-command",
        status: "denied",
        metadata: expect.objectContaining({
          agentFrameworkToolStatus: "denied",
        }),
      }),
    ]);
  });

  it("does not reuse one no-id Codex command log for repeated identical tools", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "function_call",
            call_id: "call-command-1",
            name: "exec_command",
            arguments: { command: "npm test -- --runInBand" },
          },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-06-20T10:00:01.000Z",
          payload: {
            type: "function_call",
            call_id: "call-command-2",
            name: "exec_command",
            arguments: { command: "npm test -- --runInBand" },
          },
        }),
      ],
      toolLogEntries: [{
        ts: 1,
        tool: "Bash",
        cmd: "npm test -- --runInBand",
        status: "denied",
        gate: "test",
        reason: "blocked",
        ms: 1,
      }],
    });

    expect(projection.toolCalls.map((tool) => ({
      id: tool.id,
      status: tool.status,
      toolStatus: tool.metadata?.agentFrameworkToolStatus,
      toolUseId: tool.metadata?.agentFrameworkToolUseId,
    }))).toEqual([
      { id: "call-command-1", status: "running", toolStatus: undefined, toolUseId: undefined },
      { id: "call-command-2", status: "running", toolStatus: undefined, toolUseId: undefined },
    ]);
  });

  it("extracts Codex context and compaction metadata from transcript rows", () => {
    const projection = projectTranscriptLines({
      adapterName: "codex",
      rawLines: [
        JSON.stringify({
          type: "turn_context",
          timestamp: "2026-06-20T10:00:00.000Z",
          payload: {
            type: "turn_context",
            context_window: 200000,
            remaining_context_tokens: 150000,
            used_tokens: 50000,
          },
        }),
        JSON.stringify({
          type: "conversation_compaction",
          timestamp: "2026-06-20T10:05:00.000Z",
          payload: {
            type: "conversation_compaction",
            reason: "context_limit",
            summary: "Earlier context summarized.",
          },
        }),
      ],
    });

    expect(projection.providerPatch.context).toEqual({
      usedTokens: 50000,
      maxTokens: 200000,
      remainingTokens: 150000,
    });
    expect(projection.providerPatch.compaction).toEqual({
      lastCompactedAt: "2026-06-20T10:05:00.000Z",
      events: [{
        type: "conversation_compaction",
        sourceLine: 2,
        timestamp: "2026-06-20T10:05:00.000Z",
        reason: "context_limit",
        summary: "Earlier context summarized.",
      }],
    });
  });
});
