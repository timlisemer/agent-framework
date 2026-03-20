import { describe, it, expect } from "vitest";
import { readMarkdownSection } from "../../src/utils/markdown-parser.js";

describe("readMarkdownSection", () => {
  it("returns empty string when heading not found", () => {
    const content = "## Other\nSome content";
    expect(readMarkdownSection(content, "Missing")).toBe("");
  });

  it("extracts body between two ## headings", () => {
    const content = "## First\nContent A\n## Second\nContent B";
    expect(readMarkdownSection(content, "First")).toBe("Content A");
  });

  it("extracts last section (no trailing ## heading)", () => {
    const content = "## First\nContent A\n## Last\nContent B\nMore content";
    expect(readMarkdownSection(content, "Last")).toBe("Content B\nMore content");
  });

  it("trims leading and trailing whitespace from extracted body", () => {
    const content = "## Section\n\n  Content  \n\n## Next";
    expect(readMarkdownSection(content, "Section")).toBe("Content");
  });

  it("returns empty string for section with empty body", () => {
    const content = "## Empty\n## Next";
    expect(readMarkdownSection(content, "Empty")).toBe("");
  });

  it("extracts only the requested section when multiple exist", () => {
    const content = "## A\nAlpha\n## B\nBravo\n## C\nCharlie";
    expect(readMarkdownSection(content, "B")).toBe("Bravo");
  });

  it("does not match ### headings", () => {
    const content = "### Section\nNot matched\n## Section\nMatched";
    expect(readMarkdownSection(content, "Section")).toBe("Matched");
  });

  it("requires exact heading match", () => {
    const content = "## Foobar\nContent";
    expect(readMarkdownSection(content, "Foo")).toBe("");
  });
});
