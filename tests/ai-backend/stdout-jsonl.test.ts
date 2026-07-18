import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
import { parseClientFrame, readClientFrames, writeBackendFrame } from "../../src/ai-backend/wire.js";
import { MAXIMUM_CLIENT_FRAME_BYTES } from "../../src/scenario/protocol/limits.js";
import type {
  ScenarioBackendFrame,
  ScenarioClientFrame,
} from "../../src/scenario/protocol/gateway.js";

describe("AI backend JSONL wire", () => {
  it("parses Scenario hello frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "hello",
        client: { name: "wire-test", version: "1" },
        capabilities: ["run.read"],
        schemaDigests: ["sha256:test"],
      })
    );

    expect(frame).toMatchObject({
      type: "hello",
      capabilities: ["run.read"],
    });
  });

  it("rejects client-asserted authority on the stdio protocol", () => {
    expect(() => parseClientFrame(JSON.stringify({
      type: "hello",
      client: { name: "untrusted-client", version: "1" },
      capabilities: ["feedback.write"],
      schemaDigests: [],
      authority: {
        subjectId: "another-user",
        clientId: "forged-transport",
        clientVersion: "999",
        scopes: ["state.inspectSensitive"],
        visibilityScope: ["authorizedSensitive"],
      },
    }))).toThrow();
  });

  it("parses Scenario gateway request frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        requestId: "request-1",
        payload: {
          operation: "startProviderRun",
          config: {
            model: null,
            workingDir: null,
            systemPrompt: null,
            continuable: true,
            sdkRuntimeEnvironment: "user",
            runtimeHome: { kind: "managed", configuration: { profile: "default" } },
          },
        },
      })
    );

    expect(frame).toMatchObject({
      type: "request",
      requestId: "request-1",
      payload: {
        operation: "startProviderRun",
        config: { continuable: true, runtimeHome: { kind: "managed" } },
      },
    });
  });

  it("parses run attachment, cursor, and control requests", () => {
    expect(parseClientFrame(JSON.stringify({
      type: "request",
      requestId: "request-1",
      payload: { operation: "attachRun", runId: "run-1" },
    }))).toMatchObject({
      type: "request",
      payload: { operation: "attachRun", runId: "run-1" },
    });

    expect(parseClientFrame(JSON.stringify({
      type: "request",
      requestId: "request-2",
      payload: { operation: "recordsAfter", runId: "run-1", afterSeq: 4 },
    }))).toMatchObject({
      type: "request",
      payload: { operation: "recordsAfter", afterSeq: 4 },
    });

    expect(parseClientFrame(JSON.stringify({
      type: "request",
      requestId: "request-3",
      payload: { operation: "closeProviderRun", runId: "run-1" },
    }))).toMatchObject({
      type: "request",
      payload: { operation: "closeProviderRun", runId: "run-1" },
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
          operation: "sendConversationInput",
          runId: "run-1",
          input: "missing turn id",
        },
      }))
    ).toThrow();
  });

  it("reports malformed frames without swallowing handler failures", async () => {
    const input = Readable.from([
      `${JSON.stringify({ type: "request" })}\n`,
      `${JSON.stringify({
        type: "hello",
        client: { name: "wire-test", version: "1" },
        capabilities: [],
        schemaDigests: [],
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

  it("rejects an oversized unterminated frame before the input stream ends", async () => {
    const input = new PassThrough();
    let resolveRejected!: () => void;
    const rejected = new Promise<void>((resolve) => { resolveRejected = resolve; });
    const frames: ScenarioClientFrame[] = [];
    const reading = readClientFrames(
      (frame) => { frames.push(frame); },
      input,
      (error) => {
        expect(error).toEqual(expect.objectContaining({ message: "Client frame exceeds maximum size" }));
        resolveRejected();
      },
    );
    input.write(Buffer.alloc(Math.floor(MAXIMUM_CLIENT_FRAME_BYTES / 2), 0x78));
    input.write(Buffer.alloc(Math.floor(MAXIMUM_CLIENT_FRAME_BYTES / 2) + 2, 0x78));

    await rejected;
    expect(input.writableEnded).toBe(false);

    input.write(`\n${JSON.stringify({
      type: "hello",
      client: { name: "bounded-wire-test", version: "1" },
      capabilities: [],
      schemaDigests: [],
    })}\n`);
    input.end();
    await reading;
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ type: "hello", client: { name: "bounded-wire-test" } });
  });

  it("parses Scenario tool-decision request frames", () => {
    const frame = parseClientFrame(
      JSON.stringify({
        type: "request",
        requestId: "request-decision",
        payload: {
          operation: "submitToolDecision",
          runId: "run-1",
          toolCallId: "tool-1",
          decision: "deny",
          reason: "not needed",
        },
      })
    );

    expect(frame).toMatchObject({
      type: "request",
      payload: { operation: "submitToolDecision", runId: "run-1" },
    });
  });

  it("writes one Scenario JSON object per stdout line", () => {
    const stdout = new PassThrough();
    let output = "";
    stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
    });

    const frame: ScenarioBackendFrame = {
      type: "welcome",
      subjectId: "test-user",
      engineVersion: "test",
      schemaDigest: "sha256:test",
      capabilities: ["run.read"],
      maximumFrameBytes: 1024,
      maximumArtifactBytes: 2048,
      visibilityScope: ["public"],
      extensionSchemas: [],
    };

    writeBackendFrame(frame, stdout);
    expect(output.endsWith("\n")).toBe(true);
    expect(JSON.parse(output)).toMatchObject({ type: "welcome", schemaDigest: "sha256:test" });
  });
});
