import { describe, it, expect } from "vitest";
import {
  cleanMarkerContent,
  parseIntentOutput,
  parseActionsOutput,
} from "../../src/utils/summary-updater-parsing.js";

describe("cleanMarkerContent", () => {
  it("removes trailing ---", () => {
    expect(cleanMarkerContent("content\n---")).toBe("content");
  });

  it("removes trailing --- with whitespace", () => {
    expect(cleanMarkerContent("content\n---  \n")).toBe("content");
  });

  it("preserves content without trailing ---", () => {
    expect(cleanMarkerContent("content")).toBe("content");
  });

  it("handles empty string", () => {
    expect(cleanMarkerContent("")).toBe("");
  });

  it("preserves standalone --- (not trailing after content)", () => {
    expect(cleanMarkerContent("---")).toBe("---");
  });

  it("preserves --- in the middle of content", () => {
    expect(cleanMarkerContent("before\n---\nafter")).toBe("before\n---\nafter");
  });
});

describe("parseIntentOutput", () => {
  it("parses standard output with both markers", () => {
    const output = "---INTENT---\nfix auth bug\n---APPROVALS---\n(none)";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("fix auth bug");
    expect(result.approvals).toBe("(none)");
  });

  it("cleans trailing --- from captured content", () => {
    const output = "---INTENT---\ncontent\n---APPROVALS---\napprovals\n---";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("content");
    expect(result.approvals).toBe("approvals");
  });

  it("falls back to entire output as intent when no markers", () => {
    const output = "Just plain intent text";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("Just plain intent text");
    expect(result.approvals).toBeUndefined();
  });

  it("handles only intent marker without approvals", () => {
    const output = "---INTENT---\ncontent only";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("content only");
    expect(result.approvals).toBeUndefined();
  });

  it("returns empty object for empty output", () => {
    const result = parseIntentOutput("");
    expect(result.intent).toBeUndefined();
    expect(result.approvals).toBeUndefined();
  });

  it("returns empty object for whitespace-only output", () => {
    const result = parseIntentOutput("   \n  ");
    expect(result.intent).toBeUndefined();
    expect(result.approvals).toBeUndefined();
  });

  it("trims whitespace around captured content", () => {
    const output = "---INTENT---\n  spaced content  \n---APPROVALS---\n  spaced approvals  ";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("spaced content");
    expect(result.approvals).toBe("spaced approvals");
  });

  it("handles multiline intent content", () => {
    const output = "---INTENT---\n- Fix JWT bug\n- Update tests\n- No refactoring\n---APPROVALS---\n(none)";
    const result = parseIntentOutput(output);
    expect(result.intent).toBe("- Fix JWT bug\n- Update tests\n- No refactoring");
    expect(result.approvals).toBe("(none)");
  });

  it("handles intent marker with empty content before approvals", () => {
    const output = "---INTENT---\n\n---APPROVALS---\nsome approval";
    const result = parseIntentOutput(output);
    expect(result.intent).toBeUndefined();
    expect(result.approvals).toBe("some approval");
  });
});

describe("parseActionsOutput", () => {
  it("parses standard output with both markers", () => {
    const output = "---ACTIONS---\n- did stuff\n---MISALIGNMENTS---\n(none detected)";
    const result = parseActionsOutput(output);
    expect(result.actions).toBe("- did stuff");
    expect(result.misalignments).toBe("(none detected)");
  });

  it("cleans trailing --- from captured content", () => {
    const output = "---ACTIONS---\n- action\n---MISALIGNMENTS---\n(none)\n---";
    const result = parseActionsOutput(output);
    expect(result.actions).toBe("- action");
    expect(result.misalignments).toBe("(none)");
  });

  it("falls back to entire output as actions when no markers", () => {
    const output = "- Read files\n- Made edits";
    const result = parseActionsOutput(output);
    expect(result.actions).toBe("- Read files\n- Made edits");
    expect(result.misalignments).toBeUndefined();
  });

  it("returns empty object for empty output", () => {
    const result = parseActionsOutput("");
    expect(result.actions).toBeUndefined();
    expect(result.misalignments).toBeUndefined();
  });

  it("preserves (none detected) as-is for misalignments", () => {
    const output = "---ACTIONS---\n- stuff\n---MISALIGNMENTS---\n(none detected)";
    const result = parseActionsOutput(output);
    expect(result.misalignments).toBe("(none detected)");
  });

  it("handles multiline actions", () => {
    const output = "---ACTIONS---\n- Read 5 config files\n- Fixed JWT expiry\n- Updated tests\n---MISALIGNMENTS---\n(none detected)";
    const result = parseActionsOutput(output);
    expect(result.actions).toBe("- Read 5 config files\n- Fixed JWT expiry\n- Updated tests");
  });
});
