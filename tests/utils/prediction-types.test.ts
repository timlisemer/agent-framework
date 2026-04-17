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

  it("returns false for frustrated + normal/high trust", () => {
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "normal" })),
    ).toBe(false);
    expect(
      isHighFrictionPrediction(makePrediction({ mood: "frustrated", trust: "high" })),
    ).toBe(false);
  });

  it("returns false for neutral / satisfied / happy moods", () => {
    expect(isHighFrictionPrediction(makePrediction({ mood: "neutral" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "satisfied" }))).toBe(false);
    expect(isHighFrictionPrediction(makePrediction({ mood: "happy" }))).toBe(false);
  });
});
