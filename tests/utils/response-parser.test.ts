import { describe, it, expect } from "vitest";
import { extractTextFromResponse } from "../../src/utils/response-parser.js";
import type Anthropic from "@anthropic-ai/sdk";

function makeTextBlock(text: string): Anthropic.Messages.ContentBlock {
  return { type: "text", text, citations: null } as unknown as Anthropic.Messages.ContentBlock;
}

function makeResponse(content: Anthropic.Messages.ContentBlock[]): Anthropic.Messages.Message {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content,
    model: "test",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  } as unknown as Anthropic.Messages.Message;
}

describe("extractTextFromResponse", () => {
  it("returns empty string for null response", () => {
    expect(extractTextFromResponse(null as unknown as Anthropic.Messages.Message)).toBe("");
  });

  it("returns empty string when content array is empty", () => {
    expect(extractTextFromResponse(makeResponse([]))).toBe("");
  });

  it("returns empty string when no text block exists", () => {
    const response = makeResponse([
      { type: "tool_use", id: "tu_1", name: "test", input: {} } as unknown as Anthropic.Messages.ContentBlock,
    ]);
    expect(extractTextFromResponse(response)).toBe("");
  });

  it("returns trimmed text from the first text block", () => {
    const response = makeResponse([makeTextBlock("  APPROVE  ")]);
    expect(extractTextFromResponse(response)).toBe("APPROVE");
  });

  it("returns first text block when multiple exist", () => {
    const response = makeResponse([makeTextBlock("FIRST"), makeTextBlock("SECOND")]);
    expect(extractTextFromResponse(response)).toBe("FIRST");
  });
});
