import { describe, expect, it } from "vitest";
import { canonicalizeToolCall } from "../../adapters/codex/canonicalize-tool-call.js";

describe("Codex canonicalizeToolCall", () => {
  it("canonicalizes structured apply_patch file_paths from SDK events", () => {
    expect(canonicalizeToolCall("apply_patch", {
      file_paths: ["/repo/src/a.ts", "/repo/src/c.ts"],
    })).toEqual({
      toolName: "Edit",
      toolInput: {
        file_path: "/repo/src/a.ts",
        file_paths: ["/repo/src/a.ts", "/repo/src/c.ts"],
      },
    });
  });

  it("canonicalizes raw edit_file and write_file aliases", () => {
    expect(canonicalizeToolCall("edit_file", { file_path: "/repo/src/a.ts" })).toEqual({
      toolName: "Edit",
      toolInput: { file_path: "/repo/src/a.ts" },
    });
    expect(canonicalizeToolCall("write_file", { file_path: "/repo/src/b.ts" })).toEqual({
      toolName: "Write",
      toolInput: { file_path: "/repo/src/b.ts" },
    });
  });
});
