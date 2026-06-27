import { describe, expect, it } from "vitest";
import { parseTranscript } from "../../adapters/codex/parse-transcript.js";

describe("Codex transcript parser", () => {
  it("materializes completed Plan items as proposed plan assistant text", () => {
    const entries = parseTranscript([
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: "Plan",
            text: "Plan Name: parser-plan\n\n## User Goal\nParse plans.",
          },
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<proposed_plan>\nPlan Name: parser-plan\n\n## User Goal\nParse plans.\n</proposed_plan>",
            source: { adapter: "codex", sourceKey: "codex:assistant:inline:1", startLine: 1, endLine: 1 },
          },
        ],
      },
      source: { adapter: "codex", sourceKey: "codex:assistant:inline:1", startLine: 1, endLine: 1 },
    });
  });

  it("keeps response_item assistant output_text proposed plans as assistant text", () => {
    const entries = parseTranscript([
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [
            {
              type: "output_text",
              text: "<proposed_plan>\nPlan Name: response-item-plan\n\n## User Goal\nParse response items.\n</proposed_plan>",
            },
          ],
          phase: "final_answer",
        },
      }),
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "<proposed_plan>\nPlan Name: response-item-plan\n\n## User Goal\nParse response items.\n</proposed_plan>",
            source: { adapter: "codex", sourceKey: "codex:assistant:inline:1", startLine: 1, endLine: 1 },
          },
        ],
      },
      source: { adapter: "codex", sourceKey: "codex:assistant:inline:1", startLine: 1, endLine: 1 },
    });
  });

  it("collapses paired assistant event and response rows across metadata", () => {
    const entries = parseTranscript([
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-20T10:00:00.000Z",
        payload: { type: "agent_message", message: "Done." },
      }),
      JSON.stringify({
        type: "event_msg",
        timestamp: "2026-06-20T10:00:00.001Z",
        payload: {
          type: "token_count",
          total_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            output_tokens: 5,
            reasoning_output_tokens: 1,
          },
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-06-20T10:00:00.002Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Done." }],
        },
      }),
    ], { transcriptPath: "/tmp/codex-session.jsonl" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      usage: {
        promptTokens: 10,
        cachedTokens: 2,
        completionTokens: 5,
        reasoningTokens: 1,
        totalTokens: 15,
      },
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Done.",
          },
        ],
      },
      source: {
        adapter: "codex",
        sourceKey: "codex:assistant:/tmp/codex-session.jsonl:1",
        startLine: 1,
        endLine: 3,
      },
    });
  });

  it("keeps same-text assistant turns distinct across user boundaries", () => {
    const entries = parseTranscript([
      JSON.stringify({ payload: { type: "message", role: "user", content: "First" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Repeated" } }),
      JSON.stringify({ payload: { type: "message", role: "user", content: "Again" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "Repeated" } }),
    ]).filter((entry) => entry?.message?.role === "assistant");

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: "Repeated" }] },
      source: { startLine: 2, endLine: 2 },
    });
    expect(entries[1]).toMatchObject({
      message: { role: "assistant", content: [{ type: "text", text: "Repeated" }] },
      source: { startLine: 4, endLine: 4 },
    });
  });
});
