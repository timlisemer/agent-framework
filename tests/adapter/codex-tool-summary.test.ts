import { describe, expect, it } from "vitest";
import { codexSpec } from "../../adapters/codex/index.js";

describe("codex tool LLM summaries", () => {
  it("summarizes raw apply_patch without Claude Edit old/new fields", () => {
    const summary = codexSpec.summarizeToolCallForLlm({
      rawToolName: "apply_patch",
      rawToolInput: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** End Patch\n",
      canonicalToolName: "Edit",
      canonicalToolInput: { file_path: "src/a.ts", file_paths: ["src/a.ts"] },
    });

    expect(summary).toBe('ApplyPatch(file_paths=["src/a.ts"])');
    expect(summary).not.toContain("old_string");
    expect(summary).not.toContain("new_string");
  });

  it("falls back to canonical file_paths when raw patch text is unavailable", () => {
    const summary = codexSpec.summarizeToolCallForLlm({
      rawToolName: "apply_patch",
      rawToolInput: {},
      canonicalToolName: "Edit",
      canonicalToolInput: { file_path: "src/a.ts", file_paths: ["src/a.ts", "src/b.ts"] },
    });

    expect(summary).toBe('ApplyPatch(file_paths=["src/a.ts","src/b.ts"])');
  });
});
