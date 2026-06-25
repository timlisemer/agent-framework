import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";
import { writeManagedCodexTranscript } from "../helpers/managed-session-fixtures.js";
import { withEnvForTest } from "../helpers/provider-env.js";
import { appendJsonlEntrySync } from "../../src/utils/file-io.js";
import { getAgentFrameworkSessionDir, sessionToolLogFile } from "../../src/utils/paths.js";
import type { ToolLogEntry } from "../../src/utils/session-store.js";

describe("AI backend resume requests", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports not_found for stale opaque resume ids", async () => {
    const frames: AiBackendMessage[] = [];
    const manager = new AiBackendSessionManager((frame) => frames.push(frame));

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

  it("starts a hydrated session for a compatible managed Codex resume target", async () => {
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

      const started = harness.frames.find((frame) => frame.type === "response" && frame.response.type === "sessionStarted");
      expect(started).toMatchObject({
        type: "response",
        response: {
          type: "sessionStarted",
          sessionId: "session-resumed",
          snapshot: {
            workingDir: harness.projectDir,
            agentFrameworkSessionDir: expect.stringContaining(path.join(".agent-framework", "sessions")),
            transcript: [
              expect.objectContaining({ sequenceId: 2, role: "user", content: [{ type: "text", text: "Resume this" }] }),
              expect.objectContaining({ sequenceId: 3, role: "assistant", content: [{ type: "text", text: "Ready." }] }),
            ],
          },
        },
      });
      if (!started || started.type !== "response" || started.response.type !== "sessionStarted") {
        throw new Error("expected sessionStarted response");
      }
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "call-1",
          turnId: "history-turn-1",
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

      const started = harness.frames.find((frame) => frame.type === "response" && frame.response.type === "sessionStarted");
      if (!started || started.type !== "response" || started.response.type !== "sessionStarted") {
        throw new Error("expected sessionStarted response");
      }
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "call-denied",
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

      const started = harness.frames.find((frame) => frame.type === "response" && frame.response.type === "sessionStarted");
      if (!started || started.type !== "response" || started.response.type !== "sessionStarted") {
        throw new Error("expected sessionStarted response");
      }
      expect(started.response.snapshot.toolCalls).toEqual([
        expect.objectContaining({
          id: "sdk-call-denied",
          status: "denied",
          metadata: expect.objectContaining({
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

async function setupManagedCodexResumeHarness(
  sdkProvider: string,
  suffix: string,
  options: { toolCall?: ManagedCodexToolCallFixture; toolLog?: ToolLogEntry & { expectedStatus?: string } } = {}
): Promise<{
  frames: AiBackendMessage[];
  manager: AiBackendSessionManager;
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
  if (options.toolLog) {
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
    appendJsonlEntrySync(sessionToolLogFile(sessionDir), options.toolLog);
  }
  const frames: AiBackendMessage[] = [];
  const manager = new AiBackendSessionManager((frame) => frames.push(frame));

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
