import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  overlayPendingToolApprovals,
  type PendingToolApproval,
} from "../../src/ai-backend/provider.js";
import {
  createClaudeControlStreamState,
  mapClaudeControlStreamMessage,
  normalizeClaudeAiUsage,
  recordClaudePlanUpdate,
  resolveClaudeTranscriptBinding,
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
      { type: "plan.updated", state: { mode: "awaitingApproval", planText: "Do it", approved: false } },
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
  });

  it("overlays pending manual tool approval onto transcript snapshots", () => {
    const pending: PendingToolApproval = {
      id: "native-tool-1",
      turnId: "turn-1",
      name: "Read",
      input: { text: "Read(file_path=\"src/index.ts\")" },
      wait: { reason: "approval", since: "2026-06-20T10:00:00.000Z" },
      createdAt: "2026-06-20T10:00:00.000Z",
      updatedAt: "2026-06-20T10:00:00.000Z",
    };
    const runningProjection = {
      transcript: [],
      toolCalls: [{
        id: "native-tool-1",
        sequenceId: 1,
        turnId: "turn-1",
        name: "Read",
        input: pending.input,
        status: "running" as const,
        wait: null,
        output: [],
        result: null,
        processId: null,
        progress: null,
        elapsedMs: null,
        createdAt: "2026-06-20T10:00:00.000Z",
        updatedAt: "2026-06-20T10:00:00.000Z",
        completedAt: null,
      }],
      providerPatch: {},
      digest: "base",
      agentFrameworkSessionDir: null,
    };

    expect(overlayPendingToolApprovals(runningProjection, [pending], "turn-1").toolCalls).toEqual([
      expect.objectContaining({
        id: "native-tool-1",
        status: "waiting",
        wait: pending.wait,
        result: null,
        completedAt: null,
      }),
    ]);
    expect(overlayPendingToolApprovals({ ...runningProjection, toolCalls: [] }, [pending], "turn-1").toolCalls).toEqual([
      expect.objectContaining({
        id: "native-tool-1",
        sequenceId: 1,
        status: "waiting",
        wait: pending.wait,
      }),
    ]);
  });

  it("resolves a Claude transcript by native session id under a runtime home", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-claude-binding-"));
    try {
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
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
