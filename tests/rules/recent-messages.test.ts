import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/transcript.js", () => ({
  readTranscriptExact: vi.fn(),
}));

import { recentMessagesRule } from "../../src/rules/recent-messages.js";
import { readTranscriptExact } from "../../src/utils/transcript.js";
import type { RuleContext } from "../../src/rules/types.js";

const mockReadTranscriptExact = vi.mocked(readTranscriptExact);

function makeCtx(): RuleContext {
  return {
    hookEvent: "PreToolUse",
    toolName: "Edit",
    toolInput: {},
    toolUseId: "toolu_recent",
    transcriptPath: "/tmp/transcript.jsonl",
    projectDir: "/tmp/project",
    sessionDir: "/tmp/session",
    sessionId: "test-session",
    state: {},
    stateManager: {} as never,
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
  } as unknown as RuleContext;
}

describe("recentMessagesRule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits full recent user messages without slicing content", async () => {
    const longMessage = `${"context ".repeat(80)}now edit README.md`;
    mockReadTranscriptExact.mockResolvedValueOnce({
      user: [
        { role: "user", content: longMessage, index: 2 },
        { role: "user", content: "first request", index: 0 },
      ],
      assistant: [],
      tool: [],
      totalCount: 2,
    });

    const result = await recentMessagesRule.check(makeCtx());

    expect(mockReadTranscriptExact).toHaveBeenCalledWith("/tmp/transcript.jsonl", {
      counts: { user: 3 },
      excludeSlashCommandPrompts: true,
    });
    expect(result).toHaveProperty("llmContext");
    const llmContext = result && "llmContext" in result ? result.llmContext : "";
    expect(llmContext).toContain("first request");
    expect(llmContext).toContain(longMessage);
    expect(llmContext).toContain("now edit README.md");
  });
});
