import { describe, expect, it } from "vitest";
import { comparePlanContent } from "../../src/utils/plan-content-compare.js";

describe("comparePlanContent", () => {
  it("treats whitespace-only differences as equal", () => {
    expect(comparePlanContent("Plan Name: a\n\n## User Goal\nDo it.", "Plan Name: a  \n## User Goal\nDo it.")).toEqual({ equal: true });
  });

  it("treats newline-only differences as equal", () => {
    expect(comparePlanContent("a\nb\nc", "a b c")).toEqual({ equal: true });
  });

  it("reports small material differences with raw diff output", () => {
    const result = comparePlanContent("a\nb\nc", "a\nchanged\nc");
    expect(result.equal).toBe(false);
    if (!result.equal) {
      expect(result.tooLong).toBe(false);
      expect(result.rawDiff).toContain("@@ line 2 @@");
      expect(result.rawDiff).toContain("extracted: b");
      expect(result.rawDiff).toContain("file: changed");
    }
  });

  it("marks large raw diffs as too long", () => {
    const extracted = Array.from({ length: 300 }, (_, i) => `extracted ${i}`).join("\n");
    const file = Array.from({ length: 300 }, (_, i) => `file ${i}`).join("\n");
    const result = comparePlanContent(extracted, file);
    expect(result.equal).toBe(false);
    if (!result.equal) {
      expect(result.tooLong).toBe(true);
    }
  });
});
