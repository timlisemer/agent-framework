import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/transcript.js", () => ({
  readTranscriptExact: vi.fn(),
}));

import { recentMessagesRule } from "../../src/rules/recent-messages.js";
import { readTranscriptExact } from "../../src/utils/transcript.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const mockReadTranscriptExact = vi.mocked(readTranscriptExact);

function makeCtx() {
  return makeRuleContext({
    hookEvent: "PreToolUse",
    toolName: "Edit",
    toolInput: {},
    toolUseId: "toolu_recent",
    transcriptPath: "/tmp/transcript.jsonl",
    projectDir: "/tmp/project",
    sessionDir: "/tmp/session",
  });
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
      counts: { user: { count: 3 } },
      excludeSlashCommandPrompts: true,
    });
    expect(result).toHaveProperty("llmContext");
    const llmContext = result && "llmContext" in result ? result.llmContext : "";
    expect(llmContext).toContain("first request");
    expect(llmContext).toContain(longMessage);
    expect(llmContext).toContain("now edit README.md");
  });

  it("prefers ctx.recentUserMessages and labels the newest message", async () => {
    const ctx = {
      ...makeCtx(),
      recentUserMessages: [
        "do not edit anything, just chat",
        "now call quickpush and fix complaints by editing files",
      ],
    };

    const result = await recentMessagesRule.check(ctx);

    expect(mockReadTranscriptExact).not.toHaveBeenCalled();
    const llmContext = result && "llmContext" in result ? result.llmContext : "";
    expect(llmContext).toContain("[0] do not edit anything, just chat");
    expect(llmContext).toContain("[1 LATEST/NEWEST] now call quickpush and fix complaints by editing files");
    expect(recentMessagesRule.promptSection).toContain("newest direct user instruction wins");
  });
});
