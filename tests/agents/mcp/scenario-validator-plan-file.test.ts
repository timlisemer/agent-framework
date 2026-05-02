import { describe, it, expect } from "vitest";
import { validateScenario } from "../../../src/scenario/types.js";

function baseScenario(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "test-plan-file",
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
      planFile: { slug: "test-slug-1", content: "# Plan\n..." },
    },
    expect: { expected: "deny" },
  };
}

describe("validateScenario seed_state.planFile", () => {
  it("accepts a valid slug", () => {
    expect(() => validateScenario(baseScenario())).not.toThrow();
  });

  it("accepts an empty content string", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
      content: "",
    };
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("rejects slug = '../etc'", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "../etc",
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(
      /planFile.slug must match \[A-Za-z0-9._-\]\+/,
    );
  });

  it("rejects slug with space", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "has space",
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(
      /planFile.slug must match \[A-Za-z0-9._-\]\+/,
    );
  });

  it("rejects missing slug field", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.slug must match/);
  });

  it("rejects missing content field", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.content must be a string/);
  });

  it("rejects unknown sub-fields", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
      content: "",
      bogus: 1,
    };
    expect(() => validateScenario(s)).toThrow(
      /planFile.bogus is not a recognized field/,
    );
  });

  it("unknown_field rejection under seed_state still fires", () => {
    const s = baseScenario();
    (s.seed_state as Record<string, unknown>).unknown_field = "x";
    expect(() => validateScenario(s)).toThrow(
      /seed_state.unknown_field is not a recognized field/,
    );
  });
});
