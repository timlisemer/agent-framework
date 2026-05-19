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

    expect(entries).toEqual([
      {
        isMeta: undefined,
        message: {
          id: undefined,
          role: "assistant",
          content: [
            {
              type: "text",
              text: "<proposed_plan>\nPlan Name: parser-plan\n\n## User Goal\nParse plans.\n</proposed_plan>",
            },
          ],
        },
      },
    ]);
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

    expect(entries).toEqual([
      {
        isMeta: undefined,
        message: {
          id: undefined,
          role: "assistant",
          content: [
            {
              type: "text",
              text: "<proposed_plan>\nPlan Name: response-item-plan\n\n## User Goal\nParse response items.\n</proposed_plan>",
            },
          ],
        },
      },
    ]);
  });
});
