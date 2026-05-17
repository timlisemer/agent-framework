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
});
