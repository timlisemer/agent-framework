import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiBackendSessionManager } from "../../src/ai-backend/session-manager.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";
import { writeManagedCodexTranscript } from "../helpers/managed-session-fixtures.js";
import { withEnvForTest } from "../helpers/provider-env.js";

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
    const harness = await setupManagedCodexResumeHarness("openai-subscription", "resume");
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
            transcript: [
              expect.objectContaining({ role: "user", content: [{ type: "text", text: "Resume this" }] }),
              expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "Ready." }] }),
            ],
          },
        },
      });
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

async function setupManagedCodexResumeHarness(
  sdkProvider: string,
  suffix: string
): Promise<{
  frames: AiBackendMessage[];
  manager: AiBackendSessionManager;
  projectDir: string;
  resumeId: string;
  cleanup: () => void;
}> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `agent-framework-${suffix}-test-`));
  const restoreEnv = withEnvForTest({ AGENT_FRAMEWORK_SDK_PROVIDER: sdkProvider, HOME: home });
  const projectDir = path.join(home, "project");
  const transcriptPath = path.join(home, ".agent-framework", "astral-ai", "codex", "sessions", "codex-session.jsonl");
  writeManagedCodexTranscript({ filePath: transcriptPath, projectDir });
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
    resumeId,
    cleanup: () => {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
