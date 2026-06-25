import { describe, expect, it } from "vitest";
import { codexToolLogEntryMatchesToolCall, extractCodexToolPaths } from "../../adapters/codex/tool-payload.js";

describe("Codex tool payload helpers", () => {
  it("canonicalizes path fields with one sorted unique policy", () => {
    expect(extractCodexToolPaths({
      file_path: " src/b.ts ",
      file_paths: ["src/a.ts", "src/b.ts"],
      notebook_path: "src/notebook.ipynb",
    })).toEqual(["src/a.ts", "src/b.ts", "src/notebook.ipynb"]);
  });

  it("matches tool-log paths independent of input ordering", () => {
    expect(codexToolLogEntryMatchesToolCall(
      {
        tool: "apply_patch",
        paths: ["src/a.ts", "src/b.ts"],
      },
      "apply_patch",
      { file_paths: ["src/b.ts", "src/a.ts"] }
    )).toBe(true);
  });

  it("does not match multi-file tools that only share one path", () => {
    expect(codexToolLogEntryMatchesToolCall(
      {
        tool: "apply_patch",
        paths: ["src/a.ts", "src/b.ts"],
      },
      "apply_patch",
      { file_paths: ["src/a.ts", "src/c.ts"] }
    )).toBe(false);
  });
});
