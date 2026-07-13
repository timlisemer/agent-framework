import { describe, expect, it } from "vitest";
import {
  detectUserDirectedQuestions,
  excludeMarkdownSectionBodies,
  findMarkdownSectionRange,
  getRuleViolationHighlights,
  getVerificationStructureHighlights,
} from "../../src/utils/content-patterns.js";

describe("detectUserDirectedQuestions", () => {
  it.each([
    ["Should I refactor this function?", "should-I question"],
    ["Do you want me to fix this?", "want question"],
    ["Would you like me to proceed?", "like question"],
    ["Which approach should we take?", "approach question"],
    ["Shall I continue?", "shall-I question"],
  ])("detects %s", (text, label) => {
    expect(detectUserDirectedQuestions(text)).toEqual([expect.stringContaining(label)]);
  });

  it.each([
    "Should I do this.",
    "I wonder why this fails?",
    "wondering if this works?",
    "What is the meaning of life?",
  ])("ignores %s", (text) => {
    expect(detectUserDirectedQuestions(text)).toEqual([]);
  });

  it("returns only the first matching directed-question pattern", () => {
    expect(detectUserDirectedQuestions("Should I do what you want?")).toHaveLength(1);
  });
});

describe("getVerificationStructureHighlights", () => {
  it("flags a generic verification heading without required subsections", () => {
    expect(getVerificationStructureHighlights("## Verification\n- Run tests")).toEqual([
      expect.stringContaining("generic verification"),
    ]);
  });

  it.each([
    "## Verification\n### Assistant Verification\nRun check",
    "## Verification\n### Manual User Verification\nOpen browser",
    "## Verification\n### Manual Verification\nOpen browser",
  ])("accepts named verification structure", (content) => {
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });

  it("accepts combined assistant and manual verification subsections", () => {
    const content = "## Verification\n### Assistant Verification\nCheck\n### Manual User Verification\nBrowser";
    expect(getVerificationStructureHighlights(content)).toEqual([]);
  });

  it.each(["### Testing\n- Run", "## Test Plan\n- Run"]) (
    "recognizes generic test headings",
    (content) => expect(getVerificationStructureHighlights(content)).toHaveLength(1),
  );
});

describe("Markdown section exclusion", () => {
  it("finds section boundaries", () => {
    const content = "## User Goal\n> Option A: 5 days\n## Approach\nChosen path";
    const range = findMarkdownSectionRange(content, "User Goal");

    expect(range).not.toBeNull();
    expect(content.slice(range!.bodyStart, range!.end)).toContain("Option A");
    expect(content.slice(range!.bodyStart, range!.end)).not.toContain("Chosen path");
  });

  it("blanks selected section bodies without shifting lines", () => {
    const content = "## User Goal\n> Option A: 5 days\n## Approach\nOption A: invalid";
    const checked = excludeMarkdownSectionBodies(content, ["User Goal"]);

    expect(checked).not.toContain("> Option A: 5 days");
    expect(checked).toContain("Option A: invalid");
    expect(checked.split("\n")).toHaveLength(content.split("\n").length);
  });
});

describe("getRuleViolationHighlights", () => {
  it.each([
    ["This will take 2-3 hours", "time estimate"],
    ["Estimated 5 days of work", "time estimate"],
    ["Week 1: Setup", "timeline marker"],
    ["Day 1: Setup", "timeline marker"],
    ["Month 3: rollout", "timeline marker"],
    ["Option A: Use React", "solution branching"],
    ["Approach 1: Monolith", "solution branching"],
    ["This takes 30 minutes", "duration estimate"],
  ])("detects %s", (content, label) => {
    expect(getRuleViolationHighlights(content)).toEqual([expect.stringContaining(label)]);
  });

  it("returns one result per violating line and ignores clean lines", () => {
    expect(getRuleViolationHighlights("Takes 10 minutes\nOption A: fast\nClean line")).toHaveLength(2);
    expect(getRuleViolationHighlights("## Steps\n1. Read file\n2. Edit file")).toEqual([]);
  });
});
