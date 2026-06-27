import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AiToolCall, AiTranscriptEntry } from "../../src/ai-protocol/index.js";
import {
  createAiBackendHarness,
  requireSessionStartedFrame,
  runtimeEvents as events,
  type AiBackendHarness,
  type SessionStartedFrame,
} from "../helpers/ai-backend-harness.js";
import {
  toolCallFixture,
  transcriptEntryFixture,
} from "../helpers/ai-backend-fixtures.js";
import { writeManagedCodexTranscript } from "../helpers/managed-session-fixtures.js";
import { withEnvForTest } from "../helpers/provider-env.js";
import { appendJsonlEntrySync, writeJson } from "../../src/utils/file-io.js";
import { jsonBigintReplacer } from "../../src/utils/json.js";
import { getAgentFrameworkSessionDir, sessionToolLogFile } from "../../src/utils/paths.js";
import type { ToolLogEntry } from "../../src/utils/session-store.js";

const LEGACY_TIMELINE_STATE_SCHEMA_VERSION = 1;

type LegacyTimelineState = {
  schemaVersion: typeof LEGACY_TIMELINE_STATE_SCHEMA_VERSION;
  lastEventSeq: number;
  lastTimelineSeq: number;
  transcript: AiTranscriptEntry[];
  toolCalls: AiToolCall[];
};

const provider = vi.hoisted(() => ({
  createResumeProviderRunner: vi.fn(),
  runTurn: vi.fn(),
  ResumeProviderMismatchError: class ResumeProviderMismatchError extends Error {
    constructor(targetProvider: string, configuredRuntime: string) {
      super(`Resume target provider ${targetProvider} is incompatible with configured SDK runtime ${configuredRuntime}.`);
      this.name = "ResumeProviderMismatchError";
    }
  },
}));

vi.mock("../../src/ai-backend/provider.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/ai-backend/provider.js")>();
  return {
    ...actual,
    createResumeProviderRunner: provider.createResumeProviderRunner,
    ResumeProviderMismatchError: provider.ResumeProviderMismatchError,
  };
});

describe("AI backend resume requests", () => {
  beforeEach(() => {
    provider.createResumeProviderRunner.mockReset();
    provider.runTurn.mockReset();
    provider.createResumeProviderRunner.mockImplementation((_config, target: { provider: "codex" | "claude" }) => {
      const configuredRuntime = (process.env.AGENT_FRAMEWORK_SDK_PROVIDER ?? "").startsWith("claude")
        ? "claude"
        : "codex";
      if (target.provider !== configuredRuntime) {
        throw new provider.ResumeProviderMismatchError(target.provider, configuredRuntime);
      }
      return {
        resolvedProvider: {
          type: "openrouter",
          mode: "sdk",
          modelId: "test-model",
          sdkRuntime: configuredRuntime,
          costTracking: "none",
        },
        runTurn: provider.runTurn,
      };
    });
    provider.runTurn.mockImplementation(() =>
      events({ type: "turn.completed", usage: null })
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports not_found for stale opaque resume ids", async () => {
    const { frames, manager } = createAiBackendHarness();

    await manager.handle({
      type: "request",
      request: {
        type: "resumeSession",
        requestId: "request-resume",
        sessionId: "session-resume",
        resumeId: "stale",
        config: {
          model: null,
          workingDir: null,
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "user",
          sdkRuntimeHome: "managedAstral",
        },
      },
    });

    expect(frames).toEqual([{
      type: "response",
      response: {
        type: "requestError",
        requestId: "request-resume",
        sessionId: "session-resume",
        code: "not_found",
        message: "Resume target was not found.",
        recoverable: true,
      },
    }]);
  });

  it("starts a hydrated no-sidecar session for a compatible managed Codex resume target", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume", {
      toolCall: {
        callId: "call-1",
        name: "exec_command",
        toolArguments: { command: "git status --short" },
        output: " M src/app.ts\n",
      },
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume",
          sessionId: "session-resumed",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed");
      expect(started).toMatchObject({
        type: "response",
        response: {
          type: "sessionStarted",
          sessionId: "session-resumed",
          snapshot: {
            workingDir: harness.projectDir,
            agentFrameworkSessionDir: expect.stringContaining(path.join(".agent-framework", "sessions")),
            transcript: [
              expect.objectContaining({ sequenceId: 1, role: "user", content: [{ type: "text", text: "Resume this" }] }),
              expect.objectContaining({ sequenceId: 2, role: "assistant", content: [{ type: "text", text: "Ready." }] }),
            ],
          },
        },
      });
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "call-1",
          sequenceId: 3,
          turnId: expect.stringMatching(/^turn-/),
          name: "exec_command",
          status: "completed",
          output: [{ type: "text", text: " M src/app.ts\n" }],
          result: {
            state: "completed",
            output: [{ type: "text", text: " M src/app.ts\n" }],
            error: null,
          },
        }),
      ]);
      expect(started.response.snapshot.agentFrameworkSessionDir).toBeTruthy();
      const sidecar = path.join(started.response.snapshot.agentFrameworkSessionDir!, "transcript-path.txt");
      expect(fs.readFileSync(sidecar, "utf-8").trim()).toBe(harness.transcriptPath);
      expect(uniqueTimelineSequences(started.response.snapshot)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("cancels active transcript tools when hydrating an idle resumed session", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-running-tool", {
      toolCall: {
        callId: "call-running",
        name: "mcp__agent_framework__check",
        toolArguments: { working_dir: "/workspace/project" },
      },
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-running-tool",
          sessionId: "session-resumed-running-tool",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-running-tool");
      expect(started.response.snapshot.status).toBe("idle");
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "call-running",
          name: "mcp__agent_framework__check",
          status: "cancelled",
          wait: null,
          progress: null,
          result: { state: "cancelled", output: [], error: null },
          completedAt: expect.any(String),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("ignores old timeline sidecars and projects resume rows from the raw transcript", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-sidecar", {
      timelineState: timelineStateFixture({
        userId: "persisted-user",
        assistantId: "persisted-assistant",
        toolId: "persisted-tool",
        toolInputText: "git status --short",
      }),
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-sidecar",
          sessionId: "session-resumed-sidecar",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-sidecar");
      expect(started.response.snapshot.lastEventSeq).toBe(0);
      expect(started.response.snapshot.transcript.map((entry) => entry.sequenceId)).toEqual([1, 2]);
      expect(started.response.snapshot.toolCalls).toEqual([]);

      await harness.manager.handle({
        type: "request",
        request: {
          type: "setPlanState",
          sessionId: "session-resumed-sidecar",
          state: { mode: "planning", planText: "Next", approved: false },
        },
      });
      const planEvent = harness.frames.find((frame) =>
        frame.type === "event" && frame.event.type === "planStateChanged"
      );
      if (!planEvent || planEvent.type !== "event") {
        throw new Error("expected planStateChanged event");
      }
      expect(planEvent.event.seq).toBe(1);
      expect(planEvent.snapshot.lastEventSeq).toBe(1);
      expect(planEvent.snapshot.agentFrameworkSessionDir).toBe(started.response.snapshot.agentFrameworkSessionDir);
      expect(renderedTranscript(planEvent.snapshot.transcript)).toEqual(renderedTranscript(started.response.snapshot.transcript));
      expect(renderedTools(planEvent.snapshot.toolCalls)).toEqual(renderedTools(started.response.snapshot.toolCalls));
    } finally {
      harness.cleanup();
    }
  });

  it("does not use old timeline state rows with bigint tool JSON output as resume data", async () => {
    const bigintOutput = [{ type: "json" as const, value: { count: BigInt(1) } }];
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-sidecar-bigint", {
      timelineState: timelineStateFixture({
        userId: "persisted-user-bigint",
        assistantId: "persisted-assistant-bigint",
        toolId: "persisted-tool-bigint",
        toolInputText: "count things",
        toolOutput: bigintOutput,
      }),
    });
    try {
      const sessionDir = getAgentFrameworkSessionDir({
        transcriptPath: harness.transcriptPath,
        projectDir: harness.projectDir,
      });
      const persisted = JSON.parse(fs.readFileSync(legacyTimelineStateFile(sessionDir), "utf-8")) as LegacyTimelineState;
      expect(persisted.toolCalls[0]?.output).toEqual([{ type: "json", value: { count: "1" } }]);

      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-sidecar-bigint",
          sessionId: "session-resumed-sidecar-bigint",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-sidecar-bigint");
      expect(started.response.snapshot.toolCalls).toEqual([]);
    } finally {
      harness.cleanup();
    }
  });

  it("ignores malformed timeline sidecars instead of blocking raw transcript resume", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-malformed-sidecar", {
      timelineStateJson: {
        schemaVersion: LEGACY_TIMELINE_STATE_SCHEMA_VERSION,
        lastEventSeq: 42,
        lastTimelineSeq: 9,
        transcript: [{ sequenceId: 7 }],
        toolCalls: [],
      },
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-malformed-sidecar",
          sessionId: "session-resumed-malformed-sidecar",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-malformed-sidecar");
      expect(started.response.snapshot.transcript.map((entry) => entry.sequenceId)).toEqual([1, 2]);
    } finally {
      harness.cleanup();
    }
  });

  it("keeps post-resume user, assistant, and tool rows uniquely sequenced", async () => {
    provider.runTurn.mockImplementation(() =>
      events(
        {
          type: "timeline.snapshot",
          transcript: [
            transcriptEntryFixture({
              id: "message-1",
              sequenceId: 3,
              turnId: "turn-after-resume",
              role: "user",
              text: "continue",
            }),
            transcriptEntryFixture({
              id: "message-2",
              sequenceId: 4,
              turnId: "turn-after-resume",
              role: "assistant",
              text: "Post resume answer",
            }),
          ],
          toolCalls: [
            toolCallFixture({
              id: "tool-1",
              sequenceId: 5,
              turnId: "turn-after-resume",
              name: "exec_command",
              inputText: "git status --short",
              output: [{ type: "text", text: "clean" }],
            }),
          ],
        }
      )
    );
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-post-turn", {
      timelineState: timelineStateFixture({
        userId: "message-1",
        assistantId: "message-2",
        toolId: "tool-1",
        toolInputText: "git status --short",
      }),
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-post-turn",
          sessionId: "session-resumed-post-turn",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });
      requireSessionStartedFrame(harness.frames, "session-resumed-post-turn");

      await harness.manager.handle({
        type: "request",
        request: {
          type: "sendInput",
          sessionId: "session-resumed-post-turn",
          turnId: "turn-after-resume",
          input: "continue",
        },
      });

      await vi.waitFor(() => {
        expect(harness.frames.some((frame) =>
          frame.type === "event" &&
          frame.event.type === "turnFinished" &&
          frame.event.turnId === "turn-after-resume"
        )).toBe(true);
      });
      const finished = [...harness.frames].reverse().find((frame) =>
        frame.type === "event" &&
        frame.event.type === "turnFinished" &&
        frame.event.turnId === "turn-after-resume"
      );
      if (!finished || finished.type !== "event") throw new Error("expected post-resume turnFinished frame");
      const snapshot = finished.snapshot;
      const newMessages = snapshot.transcript.filter((entry) => entry.turnId === "turn-after-resume");
      const newToolCalls = snapshot.toolCalls.filter((toolCall) => toolCall.turnId === "turn-after-resume");

      expect(newMessages.map((entry) => ({
        id: entry.id,
        role: entry.role,
        sequenceId: entry.sequenceId,
        status: entry.status,
        text: entry.content.find((block) => block.type === "text")?.text ?? "",
      }))).toEqual([
        { id: "message-1", role: "user", sequenceId: 3, status: "completed", text: "continue" },
        { id: "message-2", role: "assistant", sequenceId: 4, status: "completed", text: "Post resume answer" },
      ]);
      expect(newToolCalls).toEqual([
        expect.objectContaining({
          id: "tool-1",
          sequenceId: 5,
          status: "completed",
          output: [{ type: "text", text: "clean" }],
        }),
      ]);
      expect(uniqueTimelineSequences(snapshot)).toBe(true);
    } finally {
      harness.cleanup();
    }
  });

  it("starts a hydrated session with denied Codex tools from agent-framework tool logs", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-denied", {
      toolCall: {
        callId: "call-denied",
        name: "exec_command",
        toolArguments: { command: "sed -n '1,20p' .env" },
        output: "Command blocked by PreToolUse hook: .env reads are denied",
        outputStatus: "failed",
      },
      toolLog: {
        ts: Date.parse("2026-06-20T10:04:00.000Z"),
        tool: "Bash",
        toolUseId: "call-denied",
        cmd: "sed -n '1,20p' .env",
        status: "denied",
        gate: "blacklist",
        reason: ".env reads are denied",
        expectedStatus: "deny",
        ms: 4,
      },
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-denied",
          sessionId: "session-resumed-denied",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-denied");
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "call-denied",
          sequenceId: 3,
          name: "exec_command",
          status: "denied",
          output: [{ type: "text", text: "Command blocked by PreToolUse hook: .env reads are denied" }],
          result: {
            state: "denied",
            output: [{ type: "text", text: "Command blocked by PreToolUse hook: .env reads are denied" }],
            error: {
              code: "runtime_error",
              message: "Tool denied (Bash / blacklist): .env reads are denied",
              recoverable: false,
              metadata: expect.objectContaining({
                agentFrameworkRule: "blacklist",
                agentFrameworkToolName: "Bash",
                agentFrameworkToolStatus: "denied",
                agentFrameworkToolUseId: "call-denied",
                agentFrameworkCommand: "sed -n '1,20p' .env",
                agentFrameworkExpectedStatus: "deny",
              }),
            },
          },
          metadata: expect.objectContaining({
            agentFrameworkRule: "blacklist",
            agentFrameworkToolStatus: "denied",
          }),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("hydrates denied Codex tools when SDK call IDs differ from hook tool IDs", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-denied-mismatch", {
      toolCall: {
        callId: "sdk-call-denied",
        name: "exec_command",
        toolArguments: { command: "sed -n '1,20p' .env" },
        output: "Command blocked by PreToolUse hook: .env reads are denied",
      },
      toolLog: {
        ts: Date.parse("2026-06-20T10:04:00.000Z"),
        tool: "Bash",
        toolUseId: "hook-call-denied",
        cmd: "sed -n '1,20p' .env",
        status: "denied",
        gate: "blacklist",
        reason: ".env reads are denied",
        expectedStatus: "deny",
        ms: 4,
      },
    });
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-denied-mismatch",
          sessionId: "session-resumed-denied-mismatch",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      const started = requireSessionStartedFrame(harness.frames, "session-resumed-denied-mismatch");
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "sdk-call-denied",
          sequenceId: 3,
          name: "exec_command",
          status: "denied",
          output: [{ type: "text", text: "Command blocked by PreToolUse hook: .env reads are denied" }],
          result: {
            state: "denied",
            output: [{ type: "text", text: "Command blocked by PreToolUse hook: .env reads are denied" }],
            error: {
              code: "runtime_error",
              message: "Tool denied (Bash / blacklist): .env reads are denied",
              recoverable: false,
              metadata: expect.objectContaining({
                agentFrameworkRule: "blacklist",
                agentFrameworkToolName: "Bash",
                agentFrameworkToolStatus: "denied",
                agentFrameworkToolUseId: "hook-call-denied",
                agentFrameworkCommand: "sed -n '1,20p' .env",
                agentFrameworkExpectedStatus: "deny",
              }),
            },
          },
          metadata: expect.objectContaining({
            agentFrameworkRule: "blacklist",
            agentFrameworkToolStatus: "denied",
            agentFrameworkToolUseId: "hook-call-denied",
          }),
        }),
      ]);
    } finally {
      harness.cleanup();
    }
  });

  it("rejects managed resume targets that do not match the configured SDK runtime", async () => {
    const harness = await setupManagedCodexResumeHarness("claude-subscription", "resume-mismatch");
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume",
          sessionId: "session-mismatch",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "managedAstral",
          },
        },
      });

      expect(harness.frames).toContainEqual({
        type: "response",
        response: {
          type: "requestError",
          requestId: "request-resume",
          sessionId: "session-mismatch",
          code: "invalid_request",
          message: "Resume target provider codex is incompatible with configured SDK runtime claude.",
          recoverable: true,
        },
      });
    } finally {
      harness.cleanup();
    }
  });

  it("rejects managed resume targets when the resume request uses native runtime home", async () => {
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume-native");
    try {
      await harness.manager.handle({
        type: "request",
        request: {
          type: "resumeSession",
          requestId: "request-resume-native",
          sessionId: "session-native",
          resumeId: harness.resumeId,
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            sdkRuntimeHome: "native",
          },
        },
      });

      expect(harness.frames).toContainEqual({
        type: "response",
        response: {
          type: "requestError",
          requestId: "request-resume-native",
          sessionId: "session-native",
          code: "invalid_request",
          message: "Managed resume requires sdkRuntimeHome managedAstral and sdkRuntimeEnvironment user.",
          recoverable: true,
        },
      });
    } finally {
      harness.cleanup();
    }
  });
});

type ManagedCodexToolCallFixture = NonNullable<Parameters<typeof writeManagedCodexTranscript>[0]["toolCall"]>;

function timelineStateFixture(input: {
  userId: string;
  assistantId: string;
  toolId: string;
  toolInputText: string;
  toolOutput?: AiToolCall["output"];
  lastEventSeq?: number;
  lastTimelineSeq?: number;
}): LegacyTimelineState {
  const toolOutput: AiToolCall["output"] = input.toolOutput ?? [{ type: "text", text: " M src/app.ts\n" }];
  return {
    schemaVersion: LEGACY_TIMELINE_STATE_SCHEMA_VERSION,
    lastEventSeq: input.lastEventSeq ?? 42,
    lastTimelineSeq: input.lastTimelineSeq ?? 9,
    transcript: [
      transcriptEntryFixture({
        id: input.userId,
        sequenceId: 7,
        turnId: "turn-old",
        role: "user",
        text: "Resume this",
        createdAt: "2026-06-20T10:02:00.000Z",
      }),
      transcriptEntryFixture({
        id: input.assistantId,
        sequenceId: 8,
        turnId: "turn-old",
        role: "assistant",
        text: "Ready.",
        createdAt: "2026-06-20T10:03:00.000Z",
      }),
    ],
    toolCalls: [
      toolCallFixture({
        id: input.toolId,
        sequenceId: 9,
        turnId: "turn-old",
        inputText: input.toolInputText,
        output: toolOutput,
        createdAt: "2026-06-20T10:04:00.000Z",
        updatedAt: "2026-06-20T10:05:00.000Z",
        completedAt: "2026-06-20T10:05:00.000Z",
      }),
    ],
  };
}

function writeLegacyTimelineState(sessionDir: string, state: LegacyTimelineState): void {
  writeJson(legacyTimelineStateFile(sessionDir), state, { replacer: jsonBigintReplacer });
}

function legacyTimelineStateFile(sessionDir: string): string {
  return path.join(sessionDir, "timeline-state.json");
}

async function setupManagedCodexResumeHarness(
  sdkProvider: string,
  suffix: string,
  options: {
    toolCall?: ManagedCodexToolCallFixture;
    toolLog?: ToolLogEntry & { expectedStatus?: string };
    timelineState?: LegacyTimelineState;
    timelineStateJson?: unknown;
  } = {}
): Promise<{
  frames: AiBackendHarness["frames"];
  manager: AiBackendHarness["manager"];
  projectDir: string;
  transcriptPath: string;
  resumeId: string;
  cleanup: () => void;
}> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `agent-framework-${suffix}-test-`));
  const restoreEnv = withEnvForTest({ AGENT_FRAMEWORK_SDK_PROVIDER: sdkProvider, HOME: home });
  const projectDir = path.join(home, "project");
  const transcriptPath = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions", "codex-session.jsonl");
  writeManagedCodexTranscript({ filePath: transcriptPath, projectDir, toolCall: options.toolCall });
  if (options.timelineState) {
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
    writeLegacyTimelineState(sessionDir, options.timelineState);
  }
  if (options.timelineStateJson !== undefined) {
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
    writeJson(legacyTimelineStateFile(sessionDir), options.timelineStateJson);
  }
  if (options.toolLog) {
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
    appendJsonlEntrySync(sessionToolLogFile(sessionDir), options.toolLog);
  }
  const { frames, manager } = createAiBackendHarness();

  await manager.handle({
    type: "request",
    request: {
      type: "listSessionChoices",
      requestId: "request-list",
      config: { sdkRuntimeHome: "managedAstral", maxResults: 10 },
    },
  });
  const choices = frames.find((frame) => frame.type === "response" && frame.response.type === "sessionChoices");
  if (!choices || choices.type !== "response" || choices.response.type !== "sessionChoices") {
    throw new Error("expected sessionChoices response");
  }
  const resumeId = choices.response.sessions[0]?.resumeId;
  if (!resumeId) throw new Error("expected at least one session choice");
  return {
    frames,
    manager,
    projectDir,
    transcriptPath,
    resumeId,
    cleanup: () => {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

function renderedTranscript(transcript: AiTranscriptEntry[]): Array<{
  id: string;
  sequenceId: number;
  role: AiTranscriptEntry["role"];
  content: AiTranscriptEntry["content"];
}> {
  return transcript.map((entry) => ({
    id: entry.id,
    sequenceId: entry.sequenceId,
    role: entry.role,
    content: entry.content,
  }));
}

function renderedTools(toolCalls: AiToolCall[]): Array<{
  id: string;
  sequenceId: number;
  name: string;
  status: AiToolCall["status"];
  output: AiToolCall["output"];
  result: AiToolCall["result"];
}> {
  return toolCalls.map((toolCall) => ({
    id: toolCall.id,
    sequenceId: toolCall.sequenceId,
    name: toolCall.name,
    status: toolCall.status,
    output: toolCall.output,
    result: toolCall.result,
  }));
}

function uniqueTimelineSequences(snapshot: SessionStartedFrame["response"]["snapshot"]): boolean {
  const sequences = [
    ...snapshot.transcript.map((entry) => entry.sequenceId),
    ...snapshot.toolCalls.map((toolCall) => toolCall.sequenceId),
  ];
  return sequences.length === new Set(sequences).size;
}
