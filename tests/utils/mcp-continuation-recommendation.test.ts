import { describe, expect, it } from "vitest";
import { adapterSpecByName } from "../../src/adapter/spec.js";
import { appendMcpContinuationRecommendation } from "../../src/utils/mcp-continuation-recommendation.js";

describe("appendMcpContinuationRecommendation", () => {
  it("renders the Codex wait command with the MCP's configured timeout", () => {
    const codex = adapterSpecByName("codex");
    const description = appendMcpContinuationRecommendation(
      "check",
      "Run repository checks.",
      codex,
    );

    expect(description).toBe(
      "Run repository checks.\n\n" +
      "Recommended wait time: 330000 ms; if this MCP call yields a cell ID, use `wait({\"cell_id\":\"<cell_id>\",\"yield_time_ms\":330000})`.",
    );
    expect(codex.toolResultMayRequireContinuation(
      { toolName: "mcp-check", toolInput: {} },
    )).toBe(true);
    expect(codex.toolResultMayRequireContinuation(
      { toolName: "Read", toolInput: {} },
    )).toBe(false);
    expect(codex.continuationAfterToolResult(
      { toolName: "mcp-check", toolInput: {} },
      "Script running with cell ID cell-check",
    )).toEqual({
      toolName: "Wait",
      toolInput: { cell_id: "cell-check", yield_time_ms: 330000 },
    });
    expect(codex.continuationAfterToolResult(
      { toolName: "mcp-check", toolInput: {} },
      "Check completed synchronously.",
    )).toBeNull();
    for (const incidental of [
      { cell_id: "example" },
      { cellId: "example" },
      { content: [{ type: "text", text: "Diagnostic fixture: cell ID example" }] },
      { content: [{ type: "text", text: "{\"cell_id\":\"example\"}" }] },
      { nested: { content: [{ type: "text", text: "Script running with cell ID example" }] } },
    ]) {
      expect(codex.continuationAfterToolResult(
        { toolName: "mcp-check", toolInput: {} },
        incidental,
      )).toBeNull();
    }
  });

  it("renders Claude's blocking MCP behavior with the MCP's configured timeout", () => {
    const claude = adapterSpecByName("claude");
    const description = appendMcpContinuationRecommendation(
      "confirm",
      "Review uncommitted changes.",
      claude,
    );

    expect(description).toBe(
      "Review uncommitted changes.\n\n" +
      "Recommended wait time: 1500000 ms; wait on this MCP call directly until it completes or fails because Claude's `TaskOutput` command applies only to background tasks, not MCP calls.",
    );
    expect(claude.toolResultMayRequireContinuation(
      { toolName: "mcp-confirm", toolInput: {} },
    )).toBe(false);
    expect(claude.continuationAfterToolResult(
      { toolName: "mcp-confirm", toolInput: {} },
      { cell_id: "unused" },
    )).toBeNull();
  });
});
