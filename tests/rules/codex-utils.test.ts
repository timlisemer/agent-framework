import { describe, it, expect, afterEach } from "vitest";
import {
  extractFilePath,
  extractFilePaths,
  isLowRiskTool,
} from "../../src/rules/utils.js";
import {
  isEditIntentExemptPath,
  isEditTool,
  shouldBlockEdit,
} from "../../src/utils/edit-intent.js";

describe("Codex apply_patch tool normalization", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_ADAPTER;
  });

  it("treats apply_patch as a file edit tool", () => {
    expect(isEditTool("apply_patch")).toBe(true);
    expect(shouldBlockEdit(false, "apply_patch", "/repo/src/main.ts")).toBe(true);
  });

  it("extracts changed paths from apply_patch command text", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/main.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/new.ts",
      "+export {};",
      "*** End Patch",
    ].join("\n");
    const input = { command: patch };

    expect(extractFilePath("apply_patch", input)).toBe("src/main.ts");
    expect(extractFilePaths("apply_patch", input)).toEqual([
      "src/main.ts",
      "src/new.ts",
    ]);
    expect(extractFilePaths("apply_patch", patch)).toEqual([
      "src/main.ts",
      "src/new.ts",
    ]);
  });

  it("exempts Codex plans and AGENTS.md from edit-intent blocking", () => {
    expect(isEditIntentExemptPath("/home/user/.codex/plans/plan.md")).toBe(true);
    expect(isEditIntentExemptPath("/repo/AGENTS.md")).toBe(true);
  });

  it("does not classify apply_patch as low-risk", () => {
    expect(isLowRiskTool("apply_patch")).toBe(false);
  });
});
