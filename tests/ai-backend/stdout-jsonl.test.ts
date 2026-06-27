import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { parseClientFrame, readClientFrames, writeBackendFrame } from "../../src/ai-backend/wire.js";
import { createDefaultProviderMetadata } from "../../src/ai-backend/provider-metadata.js";
import type { AiBackendMessage, AiSessionSnapshot } from "../../src/ai-protocol/index.js";

describe("AI backend JSONL wire", () => {
  it("parses client request frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        request: {
          type: "startSession",
          sessionId: "session-jsonl",
          config: { model: null, workingDir: null, systemPrompt: null },
        },
      })
    );

    expect(frame.type).toBe("request");
    if (frame.type === "request" && frame.request.type === "startSession") {
      expect(frame.request.config.continuable).toBe(false);
      expect(frame.request.config.sdkRuntimeEnvironment).toBe("isolated");
      expect(frame.request.config.sdkRuntimeHome).toBe("native");
    }
  });

  it("parses continuable session config", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        request: {
          type: "startSession",
          sessionId: "session-jsonl",
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
          },
        },
      })
    );

    expect(frame).toMatchObject({
      type: "request",
      request: { type: "startSession", config: { continuable: true } },
    });
  });

  it("parses user SDK runtime environment session config", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        request: {
          type: "startSession",
          sessionId: "session-jsonl",
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
          },
        },
      })
    );

    expect(frame).toMatchObject({
      type: "request",
      request: { type: "startSession", config: { sdkRuntimeEnvironment: "user" } },
    });
  });

  it("parses request-correlated session choice, resume, and close requests", () => {
    expect(parseClientFrame(JSON.stringify({
      type: "request",
      request: {
        type: "listSessionChoices",
        requestId: "request-1",
        config: { sdkRuntimeHome: "managedAstral", maxResults: 10 },
      },
    }))).toMatchObject({
      type: "request",
      request: { type: "listSessionChoices", requestId: "request-1" },
    });

    expect(parseClientFrame(JSON.stringify({
      type: "request",
      request: {
        type: "resumeSession",
        requestId: "request-2",
        sessionId: "session-jsonl",
        resumeId: "resume-1",
        config: {
          model: null,
          workingDir: "/tmp/project",
          systemPrompt: null,
          continuable: true,
          sdkRuntimeEnvironment: "user",
          sdkRuntimeHome: "managedAstral",
        },
      },
    }))).toMatchObject({
      type: "request",
      request: { type: "resumeSession", requestId: "request-2" },
    });

    expect(parseClientFrame(JSON.stringify({
      type: "request",
      request: {
        type: "closeSession",
        requestId: "request-3",
        sessionId: "session-jsonl",
      },
    }))).toMatchObject({
      type: "request",
      request: { type: "closeSession", requestId: "request-3" },
    });
  });

  it("rejects malformed request frames before session handling", () => {
    expect(() =>
      parseClientFrame(JSON.stringify({ type: "request" }))
    ).toThrow();
    expect(() =>
      parseClientFrame(JSON.stringify({
        type: "request",
        request: {
          type: "sendInput",
          sessionId: "session-jsonl",
          input: "missing turn id",
        },
      }))
    ).toThrow();
  });

  it("reports malformed frames without swallowing handler failures", async () => {
    const input = Readable.from([
      `${JSON.stringify({ type: "request" })}\n`,
      `${JSON.stringify({
        type: "request",
        request: {
          type: "startSession",
          sessionId: "session-jsonl",
          config: { model: null, workingDir: null, systemPrompt: null },
        },
      })}\n`,
    ]);
    let parseErrors = 0;

    await expect(readClientFrames(
      () => {
        throw new Error("handler failed");
      },
      input,
      () => {
        parseErrors += 1;
      }
    )).rejects.toThrow("handler failed");
    expect(parseErrors).toBe(1);
  });

  it("parses generated tool-decision request frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        request: {
          type: "submitToolDecision",
          sessionId: "session-jsonl",
          turnId: "turn-jsonl",
          decision: {
            toolCallId: "tool-1",
            decision: "deny",
            reason: "not needed",
          },
        },
      })
    );

    expect(frame).toMatchObject({
      type: "request",
      request: { type: "submitToolDecision", sessionId: "session-jsonl" },
    });
  });

  it("writes one JSON object per stdout line and serializes number token counts", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const frame: AiBackendMessage = {
      type: "event",
      event: {
        type: "turnFinished",
        sessionId: "session-1",
        turnId: "turn-1",
        seq: 1,
        createdAt: "2026-05-22T00:00:00.000Z",
        usage: {
          promptTokens: 1,
          cachedTokens: null,
          completionTokens: 2,
          reasoningTokens: null,
          totalTokens: 3,
        },
      },
      snapshot: snapshotFixture(),
    };

    writeBackendFrame(frame, stdout);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output).event.usage.totalTokens).toBe(3);
  });

  it("serializes bigint values in unknown output payloads", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const frame: AiBackendMessage = {
      type: "event",
      event: {
        type: "toolCallOutput",
        sessionId: "session-1",
        turnId: "turn-1",
        seq: 1,
        createdAt: "2026-05-22T00:00:00.000Z",
        toolCallId: "tool-1",
        output: [{ type: "json", value: { count: BigInt(1) } }],
      },
      snapshot: snapshotFixture(),
    };

    writeBackendFrame(frame, stdout);
    expect(JSON.parse(output).event.output[0].value.count).toBe("1");
  });
});

function snapshotFixture(): AiSessionSnapshot {
  return {
    sessionId: "session-1",
    workingDir: null,
    agentFrameworkSessionDir: null,
    status: "idle",
    revision: 1,
    lastEventSeq: 1,
    transcript: [],
    toolCalls: [],
    backendProcesses: [],
    provider: createDefaultProviderMetadata(),
    plan: { mode: "disabled", planText: null, approved: false },
    continuation: { enabled: false, available: false, updatedAt: null },
    errors: [],
    error: null,
  };
}
