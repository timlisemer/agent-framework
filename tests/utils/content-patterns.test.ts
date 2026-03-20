import { describe, it, expect } from "vitest";
import {
  detectEmojiAddition,
  detectUserDirectedQuestions,
  getVerificationStructureHighlights,
  getRuleViolationHighlights,
  detectStyleChanges,
  formatStyleHints,
} from "../../src/utils/content-patterns.js";

describe("detectEmojiAddition", () => {
  it("returns empty array when no emojis added", () => {
    expect(detectEmojiAddition("hello world", "hello world")).toEqual([]);
  });

  it("detects single emoji addition", () => {
    const result = detectEmojiAddition("hello", "hello \u{1F600}");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("\u{1F600}");
  });

  it("detects multiple emoji additions", () => {
    const result = detectEmojiAddition("text", "text \u{1F600}\u{1F389}");
    expect(result).toHaveLength(2);
  });

  it("ignores emojis present in both old and new", () => {
    expect(detectEmojiAddition("hello \u{1F600}", "hello \u{1F600}")).toEqual([]);
  });

  it("deduplicates added emojis", () => {
    const result = detectEmojiAddition("text", "text \u{1F600}\u{1F600}\u{1F600}");
    expect(result).toHaveLength(1);
  });

  it("handles empty strings", () => {
    expect(detectEmojiAddition("", "")).toEqual([]);
  });

  it("detects emojis across unicode ranges", () => {
    // Test various emoji ranges
    const result = detectEmojiAddition("", "\u2600\u2705\u{1F680}");
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("detectUserDirectedQuestions", () => {
  it("returns empty for text not ending with ?", () => {
    expect(detectUserDirectedQuestions("Should I do this.")).toEqual([]);
  });

  it("returns empty for self-directed question", () => {
    expect(detectUserDirectedQuestions("I wonder why this fails?")).toEqual([]);
  });

  it("returns empty for 'wondering' self-directed pattern", () => {
    expect(detectUserDirectedQuestions("wondering if this works?")).toEqual([]);
  });

  it("detects 'should I' pattern", () => {
    const result = detectUserDirectedQuestions("Should I refactor this function?");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("should-I question");
  });

  it("detects 'do you want' pattern", () => {
    const result = detectUserDirectedQuestions("Do you want me to fix this?");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("want question");
  });

  it("detects 'would you like' pattern", () => {
    const result = detectUserDirectedQuestions("Would you like me to proceed?");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("like question");
  });

  it("detects 'which approach' pattern", () => {
    const result = detectUserDirectedQuestions("Which approach should we take?");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("approach question");
  });

  it("detects 'shall I' pattern", () => {
    const result = detectUserDirectedQuestions("Shall I continue?");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("shall-I question");
  });

  it("returns only first matching pattern", () => {
    // "Should I do what you want?" matches both "should I" and "do you want"
    const result = detectUserDirectedQuestions("Should I do this?");
    expect(result).toHaveLength(1);
  });

  it("returns empty for non-matching question ending with ?", () => {
    expect(detectUserDirectedQuestions("What is the meaning of life?")).toEqual([]);
  });
});

describe("getVerificationStructureHighlights", () => {
  it("returns empty when no verification heading present", () => {
    expect(getVerificationStructureHighlights("## Implementation\nSome code")).toEqual([]);
  });

  it("returns violation when ## Verification exists without subsections", () => {
    const content = "## Verification\n- Run tests\n- Check output";
    const result = getVerificationStructureHighlights(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("generic verification");
  });

  it("returns empty when 'Assistant Verification' subsection exists", () => {
    const content = "## Verification\n### Assistant Verification\nRun check tool";
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });

  it("returns empty when 'Manual User Verification' subsection exists", () => {
    const content = "## Verification\n### Manual User Verification\nOpen browser";
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });

  it("returns empty when both subsections exist", () => {
    const content = "## Verification\n### Assistant Verification\nCheck\n### Manual User Verification\nBrowser";
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });

  it("handles ### Testing heading (case-insensitive)", () => {
    const content = "### testing\n- Some tests";
    const result = getVerificationStructureHighlights(content);
    expect(result).toHaveLength(1);
  });

  it("handles ## Test Plan heading", () => {
    const content = "## Test Plan\n- Run unit tests";
    const result = getVerificationStructureHighlights(content);
    expect(result).toHaveLength(1);
  });

  it("returns empty when 'Manual Verification' (without User) exists", () => {
    const content = "## Verification\n### Manual Verification\nDo stuff";
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });
});

describe("getRuleViolationHighlights", () => {
  it("returns empty for clean content", () => {
    expect(getRuleViolationHighlights("## Steps\n1. Read file\n2. Edit file")).toEqual([]);
  });

  it("detects time estimate '2-3 hours'", () => {
    const result = getRuleViolationHighlights("This will take 2-3 hours");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("time estimate");
  });

  it("detects time estimate '5 days'", () => {
    const result = getRuleViolationHighlights("Estimated 5 days of work");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("time estimate");
  });

  it("detects timeline marker 'Week 1:'", () => {
    const result = getRuleViolationHighlights("Week 1: Setup");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("timeline marker");
  });

  it("detects solution branching 'Option A:'", () => {
    const result = getRuleViolationHighlights("Option A: Use React");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("solution branching");
  });

  it("detects solution branching 'Approach 1:'", () => {
    const result = getRuleViolationHighlights("Approach 1: Monolith");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("solution branching");
  });

  it("detects duration estimate 'takes 30'", () => {
    const result = getRuleViolationHighlights("This takes 30 minutes to complete");
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("duration estimate");
  });

  it("returns one highlight per violating line", () => {
    const content = "Takes 10 minutes\nOption A: fast\nClean line";
    const result = getRuleViolationHighlights(content);
    expect(result).toHaveLength(2);
  });
});

describe("detectStyleChanges", () => {
  it("returns empty array for identical strings", () => {
    expect(detectStyleChanges("const x = 1;", "const x = 1;")).toEqual([]);
  });

  it("detects quote change from single to double", () => {
    const changes = detectStyleChanges("const x = 'hello'", "const x = \"hello\"");
    const quoteChange = changes.find((c) => c.type === "quote");
    expect(quoteChange).toBeDefined();
    expect(quoteChange!.direction).toBe("' → \"");
  });

  it("sets violatesPreference when going away from double preference", () => {
    const changes = detectStyleChanges("const x = \"hello\"", "const x = 'hello'", "double");
    const quoteChange = changes.find((c) => c.type === "quote");
    expect(quoteChange?.violatesPreference).toBe(true);
  });

  it("sets matchesPreference when going toward double preference", () => {
    const changes = detectStyleChanges("const x = 'hello'", "const x = \"hello\"", "double");
    const quoteChange = changes.find((c) => c.type === "quote");
    expect(quoteChange?.matchesPreference).toBe(true);
  });

  it("detects semicolon addition", () => {
    const changes = detectStyleChanges("const x = 1", "const x = 1;");
    const semicolonChange = changes.find((c) => c.type === "semicolon");
    expect(semicolonChange).toBeDefined();
    expect(semicolonChange!.direction).toBe("added");
  });

  it("detects semicolon removal", () => {
    const changes = detectStyleChanges("const x = 1;", "const x = 1");
    const semicolonChange = changes.find((c) => c.type === "semicolon");
    expect(semicolonChange).toBeDefined();
    expect(semicolonChange!.direction).toBe("removed");
  });

  it("detects trailing comma addition", () => {
    const changes = detectStyleChanges("{\n  a: 1\n}", "{\n  a: 1,\n}");
    const commaChange = changes.find((c) => c.type === "trailing_comma");
    expect(commaChange).toBeDefined();
    expect(commaChange!.direction).toBe("added");
  });

  it("detects backtick addition", () => {
    const changes = detectStyleChanges("no backticks", "has `backticks`");
    const backtickChange = changes.find((c) => c.type === "backtick");
    expect(backtickChange).toBeDefined();
    expect(backtickChange!.direction).toBe("added");
  });

  it("detects emdash presence in new content", () => {
    const changes = detectStyleChanges("normal text", "text \u2014 with emdash");
    const emdashChange = changes.find((c) => c.type === "emdash");
    expect(emdashChange).toBeDefined();
    expect(emdashChange!.direction).toBe("present");
  });

  it("detects en dash as emdash variant", () => {
    const changes = detectStyleChanges("text", "text \u2013 with en dash");
    const emdashChange = changes.find((c) => c.type === "emdash");
    expect(emdashChange).toBeDefined();
  });

  it("handles null quotePreference", () => {
    const changes = detectStyleChanges("'a'", "\"a\"", null);
    const quoteChange = changes.find((c) => c.type === "quote");
    expect(quoteChange?.violatesPreference).toBeFalsy();
    expect(quoteChange?.matchesPreference).toBeFalsy();
  });
});

describe("formatStyleHints", () => {
  it("returns empty string for empty changes array", () => {
    expect(formatStyleHints([])).toBe("");
  });

  it("formats semicolon addition", () => {
    const result = formatStyleHints([{
      type: "semicolon",
      direction: "added",
      sample: "const x = 1;",
    }]);
    expect(result).toContain("[STYLE: semicolon]");
    expect(result).toContain("semicolons were added");
  });

  it("formats quote direction change", () => {
    const result = formatStyleHints([{
      type: "quote",
      direction: "' → \"",
      sample: "const x = \"hello\"",
    }]);
    expect(result).toContain("[STYLE: quote]");
    expect(result).toContain("' → \"");
  });

  it("formats emdash replacement suggestion", () => {
    const result = formatStyleHints([{
      type: "emdash",
      direction: "present",
      sample: "text \u2014 with emdash",
    }]);
    expect(result).toContain("[STYLE: emdash]");
    expect(result).toContain("replace with normal dash");
  });

  it("wraps output in === delimiters", () => {
    const result = formatStyleHints([{
      type: "backtick",
      direction: "added",
      sample: "`code`",
    }]);
    expect(result).toContain("=== STYLE CHANGES DETECTED ===");
    expect(result).toContain("=== END STYLE HINTS ===");
  });

  it("formats trailing comma removal", () => {
    const result = formatStyleHints([{
      type: "trailing_comma",
      direction: "removed",
      sample: "{ a: 1 }",
    }]);
    expect(result).toContain("trailing commas were removed");
  });

  it("formats backtick removal", () => {
    const result = formatStyleHints([{
      type: "backtick",
      direction: "removed",
      sample: "no backticks",
    }]);
    expect(result).toContain("backticks were removed");
  });
});
