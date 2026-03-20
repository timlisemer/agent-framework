import { describe, it, expect, vi } from "vitest";
import { startsWithAny, retryUntilValid } from "../../src/utils/retry.js";
import type Anthropic from "@anthropic-ai/sdk";

describe("startsWithAny", () => {
  it("returns true when text starts with one of the prefixes", () => {
    expect(startsWithAny("APPROVE this", ["APPROVE", "OK"])).toBe(true);
  });

  it("returns false when text does not start with any prefix", () => {
    expect(startsWithAny("DENY: reason", ["APPROVE", "OK"])).toBe(false);
  });

  it("returns false for empty prefix array", () => {
    expect(startsWithAny("anything", [])).toBe(false);
  });
});

describe("retryUntilValid", () => {
  function makeMockClient(responses: string[]) {
    let callIndex = 0;
    return {
      messages: {
        create: vi.fn().mockImplementation(() => {
          const text = responses[callIndex++] ?? "FALLBACK";
          return Promise.resolve({
            id: "msg_test",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text }],
            model: "test",
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          });
        }),
      },
    } as unknown as Anthropic;
  }

  it("returns initial response if format is already valid", async () => {
    const client = makeMockClient([]);
    const result = await retryUntilValid(client, "test-model", "APPROVE", "test context", {
      formatValidator: (text) => text.startsWith("APPROVE"),
      formatReminder: "Reply with APPROVE or DENY",
    });
    expect(result).toBe("APPROVE");
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it("retries when format is invalid and returns valid response", async () => {
    const client = makeMockClient(["APPROVE"]);
    const result = await retryUntilValid(client, "test-model", "Let me think... yes", "test context", {
      formatValidator: (text) => text.startsWith("APPROVE") || text.startsWith("DENY"),
      formatReminder: "Reply with APPROVE or DENY",
    });
    expect(result).toBe("APPROVE");
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it("respects maxRetries limit", async () => {
    const client = makeMockClient(["still bad", "also bad"]);
    const result = await retryUntilValid(client, "test-model", "bad format", "test context", {
      maxRetries: 2,
      formatValidator: (text) => text.startsWith("APPROVE"),
      formatReminder: "Reply with APPROVE",
    });
    expect(result).toBe("also bad");
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it("returns [RETRY ERROR] on API error", async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error("API timeout")),
      },
    } as unknown as Anthropic;

    const result = await retryUntilValid(client, "test-model", "bad format", "test context", {
      formatValidator: (text) => text.startsWith("APPROVE"),
      formatReminder: "Reply with APPROVE",
    });
    expect(result).toBe("[RETRY ERROR] API timeout");
  });

  it("passes format reminder in retry message", async () => {
    const client = makeMockClient(["APPROVE"]);
    await retryUntilValid(client, "test-model", "bad", "evaluating Bash", {
      formatValidator: (text) => text.startsWith("APPROVE"),
      formatReminder: "Reply with EXACTLY: APPROVE",
    });

    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.messages[0].content).toContain("Reply with EXACTLY: APPROVE");
    expect(callArgs.messages[0].content).toContain("evaluating Bash");
  });

  it("uses the specified model in retry requests", async () => {
    const client = makeMockClient(["APPROVE"]);
    await retryUntilValid(client, "my-model-id", "bad", "context", {
      formatValidator: (text) => text.startsWith("APPROVE"),
      formatReminder: "Fix format",
    });

    const callArgs = (client.messages.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(callArgs.model).toBe("my-model-id");
  });
});
