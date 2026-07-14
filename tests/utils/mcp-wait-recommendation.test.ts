import { describe, expect, it } from "vitest";
import { adapterSpecByName } from "../../src/adapter/spec.js";
import { appendMcpWaitRecommendation } from "../../src/utils/mcp-wait-recommendation.js";

describe("appendMcpWaitRecommendation", () => {
  it("renders the Codex wait command with the MCP's configured timeout", () => {
    const description = appendMcpWaitRecommendation(
      "check",
      "Run repository checks.",
      adapterSpecByName("codex"),
    );

    expect(description).toBe(
      "Run repository checks.\n\n" +
      "Recommended wait time: 330000 ms; if this MCP call yields a cell ID, use `wait({\"cell_id\":\"<cell_id>\",\"yield_time_ms\":330000})`.",
    );
  });

  it("renders Claude's blocking MCP behavior with the MCP's configured timeout", () => {
    const description = appendMcpWaitRecommendation(
      "confirm",
      "Review uncommitted changes.",
      adapterSpecByName("claude"),
    );

    expect(description).toBe(
      "Review uncommitted changes.\n\n" +
      "Recommended wait time: 1500000 ms; wait on this MCP call directly until it completes or fails because Claude's `TaskOutput` command applies only to background tasks, not MCP calls.",
    );
  });
});
