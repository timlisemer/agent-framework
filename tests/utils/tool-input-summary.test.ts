import { describe, expect, it } from "vitest";
import { summarizeToolInputForLlm, summarizeToolInputForUi } from "../../src/utils/tool-input-summary.js";

describe("tool input summaries", () => {
  it("exposes generic Codex UI fields", () => {
    expect(summarizeToolInputForUi("shell", { command: "git status" }).fields).toMatchObject({ command: "git status" });
    expect(summarizeToolInputForUi("search", { query: "rust gtk" }).fields).toMatchObject({ query: "rust gtk" });
    expect(summarizeToolInputForUi("file_edit", { changes: [{ path: "a.ts" }] }).fields).toMatchObject({ changeCount: 1 });
    expect(summarizeToolInputForUi("runtime_item", { itemType: "future", status: "running" }).fields).toMatchObject({ itemType: "future", status: "running" });
    expect(summarizeToolInputForUi("mcp__github__search", {
      server: "github",
      tool: "search",
      arguments: { query: "abc", limit: 3, values: [1, 2] },
    }).fields).toMatchObject({ server: "github", tool: "search", query: "abc", limit: 3, values: 2 });
  });

  it("keeps LLM summaries security-relevant", () => {
    expect(summarizeToolInputForLlm("Bash", { command: "git status --short" })).toContain("read_only=true");
    expect(summarizeToolInputForLlm("Edit", { file_path: "a.ts", old_string: "old", new_string: "new" })).toContain("old_string=3 bytes / 1 lines");
  });

});
