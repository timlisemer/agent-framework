import { describe, it, expect } from "vitest";
import { hasQuotedContent, stripQuotedAndPastedContent, stripQuotedContent } from "./quote-detection.js";

describe("hasQuotedContent", () => {
  it("detects fenced code blocks", () => {
    expect(hasQuotedContent("some text\n```\ncode\n```")).toBe(true);
  });

  it("detects CLI markers", () => {
    expect(hasQuotedContent("⎿ Tip: Install the plugin")).toBe(true);
    expect(hasQuotedContent("✶ Running build")).toBe(true);
    expect(hasQuotedContent("❯ npm install")).toBe(true);
  });

  it("detects blockquotes", () => {
    expect(hasQuotedContent("> quoted line")).toBe(true);
  });

  it("detects inline double quotes", () => {
    expect(hasQuotedContent('He said "hello"')).toBe(true);
  });

  it("detects inline single quotes", () => {
    expect(hasQuotedContent("the value 'foo' is wrong")).toBe(true);
  });

  it("detects backtick quotes", () => {
    expect(hasQuotedContent("use `npm install`")).toBe(true);
  });

  it("detects QUOTE markers", () => {
    expect(hasQuotedContent("QUOTE: some text QUOTE END")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasQuotedContent("fix the bug in auth.ts")).toBe(false);
  });
});

describe("stripQuotedAndPastedContent", () => {
  it("passes through plain text unchanged", () => {
    const text = "fix the bug in auth.ts";
    expect(stripQuotedAndPastedContent(text)).toBe(text);
  });

  it("strips fenced code blocks", () => {
    const text = "please fix this\n```typescript\nconst x = 1;\n```\nthen run tests";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("please fix this");
    expect(result).toContain("then run tests");
    expect(result).not.toContain("const x = 1");
  });

  it("strips CLI marker lines with continuation", () => {
    const text = "I got this output:\n⎿ Tip: Install the frontend-design plugin\n  for better results\n\nplease fix settings.json";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("please fix settings.json");
    expect(result).not.toContain("Install the frontend-design plugin");
    expect(result).not.toContain("for better results");
  });

  it("strips explicit QUOTE markers", () => {
    const text = "QUOTE: some pasted content QUOTE END\nfix the config";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("fix the config");
    expect(result).not.toContain("some pasted content");
  });

  it("strips indented blocks of 3+ lines", () => {
    const text = "check this:\n    line one\n    line two\n    line three\nand fix it";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("check this:");
    expect(result).toContain("and fix it");
    expect(result).not.toContain("line one");
  });

  it("preserves indented blocks shorter than 3 lines", () => {
    const text = "check this:\n    line one\n    line two\nand fix it";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("line one");
    expect(result).toContain("line two");
  });

  it("strips blockquote lines", () => {
    const text = "user said:\n> don't run anything\nplease fix the bug";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("please fix the bug");
    expect(result).not.toContain("don't run anything");
  });

  it("strips inline double-quoted content", () => {
    const text = 'the error "don\'t run execute" appeared, fix it';
    const result = stripQuotedAndPastedContent(text);
    expect(result).not.toContain("don't run execute");
    expect(result).toContain("fix it");
  });

  it("strips inline backtick content", () => {
    const text = "the command `git push origin main` failed, fix it";
    const result = stripQuotedAndPastedContent(text);
    expect(result).not.toContain("git push origin main");
    expect(result).toContain("failed, fix it");
  });

  it("preserves contractions like don't and won't", () => {
    const text = "don't run the tests, won't work yet";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("don't");
    expect(result).toContain("won't");
  });

  it("handles the exact bug-report scenario: CLI output with install markers", () => {
    const text = "update settings.json to disable the plugin\n⎿ Tip: Install the frontend-design plugin\n  This will improve your workflow\n\nand then commit";
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("update settings.json");
    expect(result).toContain("and then commit");
    expect(result).not.toContain("Install the frontend-design plugin");
  });

  it("strips triple-quoted blocks", () => {
    const text = 'before\n"""some long quote"""\nafter';
    const result = stripQuotedAndPastedContent(text);
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("some long quote");
  });
});

describe("stripQuotedContent", () => {
  it("is an alias for stripQuotedAndPastedContent", () => {
    const text = "the value `foo` is wrong, fix it";
    expect(stripQuotedContent(text)).toBe(stripQuotedAndPastedContent(text));
  });
});
