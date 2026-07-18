import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/utils/transcript.js", () => ({
  readRecentUserMessages: vi.fn(),
}));

import { predictionQuestionJudgeRule } from "../../src/rules/prediction-question-judge.js";
import { runAgent } from "../../src/utils/agent-runner.js";
import { readRecentUserMessages } from "../../src/utils/transcript.js";
import { sessionStateDefaults } from "../helpers/session-workflow.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const mockRunAgent = vi.mocked(runAgent);
const mockReadRecentUserMessages = vi.mocked(readRecentUserMessages);

const NOT_STALLING_OUTPUT = `---MOOD---
frustrated
---TRUST---
low
---INTENT---
User wants the assistant to answer the existing request.
---BLOCKED-INTENT---
(none)
---EXPLICITLY-ALLOWED-TOOLS---
(none)
---EXPLICITLY-BLOCKED---
(none)
---CONTEXT-SWITCH---
no
---QUESTION-IS-STALLING---
no
---BLOCK-ALL-TOOLS---
no`;

function makeCtx(userMessageFull: string) {
  return makeRuleContext({
    hookEvent: "PreToolUse",
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        {
          header: "Target",
          question: "Which file should I edit?",
          options: [{ label: "README", description: "Edit README.md" }],
        },
      ],
    },
    toolUseId: "toolu_question",
    transcriptPath: "/tmp/transcript.jsonl",
    projectDir: "/tmp/project",
    sessionDir: "/tmp/session",
    state: {
      ...sessionStateDefaults(),
      currentPrediction: {
        mood: "frustrated",
        trust: "low",
        intent: "User wants an edit after a long preamble.",
        blockedIntent: "",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: userMessageFull.slice(0, 200),
        userMessageFull,
        blockAllTools: false,
        timestamp: Date.now(),
      },
      frustrationStreak: 3,
      currentWindowSize: 4,
    },
  });
}

describe("predictionQuestionJudgeRule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes full recent and latest user messages to the stalling judge context", async () => {
    const fullLatest = `${"context ".repeat(80)}now edit README.md`;
    const fullRecent = `[T0] ${fullLatest}`;
    mockReadRecentUserMessages.mockResolvedValueOnce(fullRecent);
    mockRunAgent.mockResolvedValueOnce({
      output: NOT_STALLING_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });

    const result = await predictionQuestionJudgeRule.check(makeCtx(fullLatest));

    expect(result).toBeNull();
    expect(mockReadRecentUserMessages).toHaveBeenCalledWith(
      "/tmp/transcript.jsonl",
      4,
      true,
      { stripQuoted: false },
    );
    const context = mockRunAgent.mock.calls[0][1].context;
    expect(context).toContain(`RECENT USER MESSAGES (with [Tn] indices, T0 = newest):\n${fullRecent}`);
    expect(context).toContain(`LATEST USER MESSAGE:\n${fullLatest}`);
    expect(context).toContain("now edit README.md");
  });
});
