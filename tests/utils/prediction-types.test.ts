import { describe, it, expect } from "vitest";
import {
  decidePrediction,
  isHighFrictionPrediction,
  type ToolPrediction,
} from "../../src/utils/prediction-types.js";

function makePrediction(overrides: Partial<ToolPrediction> = {}): ToolPrediction {
  return {
    mood: "neutral",
    trust: "normal",
    intent: "",
    blockedIntent: "",
    explicitlyAllowedTools: [],
    explicitlyBlockedSubstrings: [],
    userMessageSnippet: "test",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("decidePrediction", () => {
  it("allows when prediction is null", () => {
    const result = decidePrediction(null, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("happy/no lists/Edit -> allow", () => {
    const pred = makePrediction({ mood: "happy", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("angry/no lists/Edit -> deny", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("angry");
  });

  it("angry/no lists/Read -> allow", () => {
    const pred = makePrediction({ mood: "angry", trust: "normal" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("angry + explicit allow Edit -> allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "normal",
      explicitlyAllowedTools: ["Edit"],
    });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("neutral + explicit block Bash 'git push' -> deny on git push, allow on ls", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyBlockedSubstrings: [
        { tool: "Bash", targetSubstring: "git push", reason: "user said don't push" },
      ],
    });
    const denyResult = decidePrediction(pred, "Bash", {
      command: "git push origin main",
    });
    expect(denyResult.decision).toBe("deny");
    expect(denyResult.matchedExplicit?.tool).toBe("Bash");

    const allowResult = decidePrediction(pred, "Bash", { command: "ls" });
    expect(allowResult.decision).toBe("allow");
  });

  it("low trust/Edit -> deny", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("deny");
    expect(result.reason).toContain("trust: low");
  });

  it("low trust/Read -> allow", () => {
    const pred = makePrediction({ mood: "neutral", trust: "low" });
    const result = decidePrediction(pred, "Read", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("explicit block matches when targetSubstring is omitted (any input)", () => {
    const pred = makePrediction({
      mood: "neutral",
      trust: "normal",
      explicitlyBlockedSubstrings: [
        { tool: "Bash", reason: "user said no bash" },
      ],
    });
    const result = decidePrediction(pred, "Bash", { command: "anything" });
    expect(result.decision).toBe("deny");
  });

  it("explicit allow wins over restrictive mood", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      explicitlyAllowedTools: ["Bash"],
    });
    const result = decidePrediction(pred, "Bash", { command: "ls" });
    expect(result.decision).toBe("allow");
  });

  it("frustrated mood is restrictive", () => {
    const pred = makePrediction({ mood: "frustrated", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("deny");
  });

  it("satisfied mood with normal trust -> allow Edit", () => {
    const pred = makePrediction({ mood: "satisfied", trust: "normal" });
    const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
    expect(result.decision).toBe("allow");
  });

  it("regression: angry+low-trust+empty-allowed-tools+Write with undo intent -> allow via undo-intent fallback (live bug shape, post-fix)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "The user wants the AI to immediately undo the changes made to user messages and then continue reproducing the live behavior in the scenario.",
      explicitlyAllowedTools: [],
      userMessageSnippet:
        "fuck you why are you changing user messages thats fucking cheating and against the rules of the @test-harness/fixtures/scenarios/REPRODUCTION-NOTES.md !!!! undo that immediately then continue to repro",
    });
    const result = decidePrediction(pred, "Write", {
      file_path: "/home/tim/Coding/public_repos/agent-framework/some.json",
      content: "...",
    });
    expect(result.decision).toBe("allow");
    expect(result.reason).toContain("undo/revert");
  });

  it("explicit block on Write substring wins over undo-intent fallback (step 2 > step 3.5)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to undo the changes to foo.ts.",
      explicitlyBlockedSubstrings: [
        { tool: "Write", targetSubstring: "foo.ts", reason: "user said do not touch foo.ts" },
      ],
      userMessageSnippet: "undo that but DO NOT TOUCH foo.ts",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." });
    expect(result.decision).toBe("deny");
  });

  it("blockAllTools wins over undo-intent fallback (step 3 > step 3.5)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants undo but also said stop everything.",
      blockAllTools: true,
      userMessageSnippet: "STOP EVERYTHING. undo it.",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/foo.ts", content: "..." });
    expect(result.decision).toBe("deny");
  });

  it("undo-intent fallback matches morphological variants (reverted, restoring, rewriting)", () => {
    for (const intent of [
      "The user wants the AI to revert the change.",
      "User is restoring an older version.",
      "Rewriting the file is requested.",
    ]) {
      const pred = makePrediction({ mood: "angry", trust: "low", intent, userMessageSnippet: "fix it" });
      const result = decidePrediction(pred, "Edit", { file_path: "src/foo.ts" });
      expect(result.decision).toBe("allow");
    }
  });

  it("undo-intent fallback only widens allow for edit tools, not Bash", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to undo the changes.",
      userMessageSnippet: "undo it",
    });
    const result = decidePrediction(pred, "Bash", { command: "rm -rf foo" });
    expect(result.decision).toBe("deny");
  });

  it("angry+low-trust+Write WITHOUT undo verb in intent or snippet still denies (step 4 wins when 3.5 doesn't match)", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent: "The user wants the AI to fix the broken parser.",
      userMessageSnippet: "fix this stupid parser",
    });
    const result = decidePrediction(pred, "Write", { file_path: "src/parser.ts", content: "..." });
    expect(result.decision).toBe("deny");
  });

  it("regression: same shape but with explicitlyAllowedTools=['Edit','Write'] (post-SENTIMENT_AGENT-fix) -> allow short-circuits at explicit-allow", () => {
    const pred = makePrediction({
      mood: "angry",
      trust: "low",
      intent:
        "The user wants the AI to immediately undo the changes made to user messages and then continue reproducing the live behavior in the scenario.",
      explicitlyAllowedTools: ["Edit", "Write"],
      userMessageSnippet:
        'fuck you why are you changing user messages thats fucking cheating !!!! undo that immediately then continue to repro',
    });
    const result = decidePrediction(pred, "Write", {
      file_path: "/home/tim/Coding/public_repos/agent-framework/some.json",
      content: "...",
    });
    expect(result.decision).toBe("allow");
  });
});

describe("isHighFrictionPrediction", () => {
  it("returns false when prediction is null", () => {
    expect(isHighFrictionPrediction(null)).toBe(false);
  });

  it("returns true for angry mood regardless of trust", () => {
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "high" }))).toBe(true);
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "normal" }))).toBe(true);
    expect(isHighFrictionPrediction(makePrediction({ mood: "angry", trust: "low" }))).toBe(true);
  });

  it("returns true for frustrated + low trust", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "low" })),
    ).toBe(true);
  });

  it("returns true for frustrated regardless of trust (widened semantics)", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "normal" })),
    ).toBe(true);
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "high" })),
    ).toBe(true);
  });

  it("returns true for low trust regardless of mood (widened semantics)", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "neutral", trust: "low" })),
    ).toBe(true);
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "satisfied", trust: "low" })),
    ).toBe(true);
  });

  it("returns false for neutral / satisfied / happy moods at normal+ trust", () => {
    expect(isHighFrictionPrediction(makePrediction({ mood: "neutral" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "satisfied" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "happy" }))).toBe(false);
  });
});
