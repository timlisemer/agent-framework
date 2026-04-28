import { describe, it, expect } from "vitest";
import { validateScenario } from "../../../src/agents/mcp/scenario-types.js";

function baseScenario(): Record<string, unknown> {
  return {
    name: "test-llm-stubs",
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

describe("validateScenario env.llm_stubs", () => {
  it("accepts { tool-appeal: UPHOLD }", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "tool-appeal": "UPHOLD" } };
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("accepts { rule-gate: APPROVE }", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "rule-gate": "APPROVE" } };
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("accepts mixed multi-agent maps", () => {
    const s = baseScenario();
    s.env = {
      llm_stubs: {
        "tool-appeal": "OVERTURN: APPROVE",
        "rule-gate": "DENY: tool-approve: nope",
        "style-drift": "OK",
      },
    };
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("rejects empty-key entries", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "": "UPHOLD" } };
    expect(() => validateScenario(s)).toThrow(
      /llm_stubs keys must be non-empty/,
    );
  });

  it("rejects empty-value entries", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "tool-appeal": "" } };
    expect(() => validateScenario(s)).toThrow(
      /llm_stubs\[.*\] must be a non-empty string/,
    );
  });

  it("rejects non-string values", () => {
    const s = baseScenario();
    s.env = { llm_stubs: { "tool-appeal": 42 } };
    expect(() => validateScenario(s)).toThrow(
      /llm_stubs\[.*\] must be a non-empty string/,
    );
  });

  it("rejects array as llm_stubs", () => {
    const s = baseScenario();
    s.env = { llm_stubs: ["UPHOLD"] };
    expect(() => validateScenario(s)).toThrow(
      /llm_stubs must be a non-null object when set/,
    );
  });
});
