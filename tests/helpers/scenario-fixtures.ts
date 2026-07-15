export function baseValidationScenario(options?: {
  name?: string;
  seedState?: Record<string, unknown>;
  expect?: unknown;
}): Record<string, unknown> {
  return {
    schema_version: 1,
    name: options?.name ?? "test-scenario",
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
      frustrationStreak: 0,
      currentWindowSize: 4,
      ...options?.seedState,
    },
    expect: options?.expect ?? { expected: "deny" },
  };
}
