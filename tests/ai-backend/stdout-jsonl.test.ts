import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { parseClientFrame, writeBackendFrame } from "../../src/ai-backend/wire.js";
import type { AiBackendMessage } from "../../src/ai-protocol/index.js";

describe("AI backend JSONL wire", () => {
  it("parses client request frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        request: {
          type: "startSession",
          sessionId: "session-jsonl",
          config: { provider: null, model: null, workingDir: null, systemPrompt: null },
        },
      })
    );

    expect(frame.type).toBe("request");
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
            providerToolCallId: "provider-tool-1",
            approve: false,
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

  it("writes one JSON object per stdout line and serializes bigint token counts", () => {
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
        usage: {
          promptTokens: 1n,
          cachedTokens: null,
          completionTokens: 2n,
          reasoningTokens: null,
          totalTokens: 3n,
        },
      },
    };

    writeBackendFrame(frame, stdout);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output).event.usage.totalTokens).toBe(3);
  });
});
