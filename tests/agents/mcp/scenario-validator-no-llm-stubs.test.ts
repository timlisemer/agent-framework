import { describe, it, expect } from "vitest";
import { validateScenario } from "../../../src/scenario/types.js";

function baseScenario(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "test-no-llm-stubs",
    transcript: [
      { role: "user", content: "do something" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_test_1",
            name: "Bash",
            input: { command: "ls" },
          },
        ],
      },
    ],
    target: { hook: "PreToolUse", tool_use_ref: "toolu_test_1" },
    seed_state: {
      currentPrediction: {
        mood: "neutral",
        trust: "normal",
        intent: "",
        blockedIntent: "",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: "do something",
      },
      forceCheckPending: false,
      frustrationStreak: 0,
      currentWindowSize: 4,
    },
    expect: { expected: "deny" },
  };
}

describe("validateScenario env bypass fields", () => {
  it("rejects llm_stubs in scenario env", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "rule-gate": "APPROVE" } };
    expect(() => validateScenario(s)).toThrow(
      /scenario\.env\.llm_stubs is not allowed/,
    );
  });
});
