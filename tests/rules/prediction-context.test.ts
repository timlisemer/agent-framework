import { describe, expect, it } from "vitest";
import { predictionContextRule } from "../../src/rules/prediction-context.js";
import { sessionStateDefaults } from "../helpers/session-workflow.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx() {
  return makeRuleContext({
    hookEvent: "PreToolUse",
    toolName: "Edit",
    toolInput: {},
    toolUseId: "toolu_prediction",
    transcriptPath: "/tmp/transcript.jsonl",
    projectDir: "/tmp/project",
    sessionDir: "/tmp/session",
    state: {
      ...sessionStateDefaults(),
      currentPrediction: {
        intent: "older chat-only instruction",
        blockedIntent: "",
        mood: "neutral",
        trust: "normal",
        blockAllTools: false,
        userMessageSnippet: "do not edit anything",
        userMessageFull: "do not edit anything, just chat",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        timestamp: Date.now(),
      },
    },
    stateManager: {} as never,
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
    latestUserMessage: "now call quickpush and fix complaints by editing files",
    latestUserTurn: {
      rawText: "now call quickpush and fix complaints by editing files",
      logicText: "now call quickpush and fix complaints by editing files",
      displaySnippet: "now call quickpush and fix complaints by editing files",
      matchesCachedPrediction: false,
    },
  });
}

describe("predictionContextRule", () => {
  it("includes live latest user message ahead of historical cached predictions", async () => {
    const result = await predictionContextRule.check(makeCtx());

    expect(result).toHaveProperty("llmContext");
    const llmContext = result && "llmContext" in result ? result.llmContext : "";
    expect(llmContext).toContain("LIVE LATEST USER MESSAGE (authoritative on conflicts):");
    expect(llmContext).toContain("now call quickpush and fix complaints by editing files");
    expect(llmContext).toContain("PREDICTIONS (historical cached context):");
    expect(predictionContextRule.promptSection).toContain("live latest user intent wins");
  });
});
