import { describe, expect, it } from "vitest";
import { scenarioSchema } from "../../../src/mcp/scenario-schema.js";
import { validateScenario } from "../../../src/scenario/types.js";

function minimalInlineScenario(): Record<string, unknown> {
  return {
    schema_version: 1,
    name: "inline-schema-version-regression",
    transcript: [
      { role: "user", content: "read src/foo.ts" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_inline_schema_version",
            name: "Read",
            input: { file_path: "src/foo.ts" },
          },
        ],
      },
    ],
    target: { hook: "PreToolUse", tool_use_ref: "toolu_inline_schema_version" },
    expect: { expected: "allow" },
    seed_state: {
      currentPrediction: {
        mood: "neutral",
        trust: "normal",
        intent: "User wants to read src/foo.ts.",
        blockedIntent: "",
        explicitlyAllowedTools: ["Read"],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: "read src/foo.ts",
      },
      forceCheckPending: false,
      frustrationStreak: 0,
      currentWindowSize: 4,
    },
  };
}

describe("scenario_tester inline MCP schema", () => {
  it("preserves schema_version before validateScenario runs", () => {
    const parsed = scenarioSchema.parse(minimalInlineScenario());

    expect(parsed.schema_version).toBe(1);
    expect(() => validateScenario(parsed)).not.toThrow();
  });

  it("rejects inline scenarios that omit schema_version", () => {
    const raw = minimalInlineScenario();
    delete raw.schema_version;

    expect(scenarioSchema.safeParse(raw).success).toBe(false);
  });

  it("accepts seed currentPrediction required and non-blocking tool queues", () => {
    const raw = minimalInlineScenario();
    const currentPrediction = (raw.seed_state as {
      currentPrediction: Record<string, unknown>;
    }).currentPrediction;
    currentPrediction.explicitlyRequiredTools = [
      {
        tool: "Agent",
        input: { subagent_type: "default" },
        inputArrayLengths: { targets: 1 },
        inputSubstrings: ["plan"],
        reason: "workflow starts with planning",
      },
    ];
    currentPrediction.nonBlockingTools = [
      { tool: "Read", reason: "inspection can continue while queued" },
    ];

    const parsed = scenarioSchema.parse(raw);

    expect(() => validateScenario(parsed)).not.toThrow();
  });

  it("rejects invalid seed tool requirement array lengths at the MCP schema layer", () => {
    const raw = minimalInlineScenario();
    const currentPrediction = (raw.seed_state as {
      currentPrediction: Record<string, unknown>;
    }).currentPrediction;
    currentPrediction.explicitlyRequiredTools = [
      { tool: "TaskOutput", inputArrayLengths: { targets: -1 } },
    ];

    expect(scenarioSchema.safeParse(raw).success).toBe(false);
  });
});
