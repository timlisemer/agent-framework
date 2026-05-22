import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { parseClientFrame, readClientFrames, writeBackendFrame } from "../../src/ai-backend/wire.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";

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
        toolCallId: "tool-1",
        seq: 1,
        createdAt: "2026-05-22T00:00:00.000Z",
        output: [{ type: "json", value: { count: BigInt(1) } }],
      },
    };

    writeBackendFrame(frame, stdout);
    expect(JSON.parse(output).event.output[0].value.count).toBe("1");
  });
});
