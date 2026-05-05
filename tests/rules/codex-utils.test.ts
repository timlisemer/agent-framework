import { describe, it, expect, afterEach } from "vitest";
import {
  extractFilePath,
  extractFilePaths,
  isLowRiskTool,
} from "../../src/rules/utils.js";
import {
  isEditIntentExemptPath,
  isEditTool,
} from "../../src/utils/edit-intent.js";

describe("Codex apply_patch tool normalization", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_ADAPTER;
  });

  it("does not treat apply_patch as a file edit tool (it is canonicalized to Edit before rules run)", () => {
    // apply_patch is canonicalized to Edit by the Codex adapter's canonicalizeToolCall
    // BEFORE any rules run. So isEditTool("apply_patch") correctly returns false.
    expect(isEditTool("apply_patch")).toBe(false);
    // The canonical Edit tool IS recognized:
    expect(isEditTool("Edit")).toBe(true);
  });

  it("extractFilePath handles canonical Edit input shape (after apply_patch canonicalization)", () => {
    // After Codex canonicalization, apply_patch becomes Edit with file_path.
    // The canonical Edit input has file_path, not the apply_patch command string.
    const editInput = { file_path: "src/main.ts" };
    expect(extractFilePath("Edit", editInput)).toBe("src/main.ts");
    expect(extractFilePaths("Edit", editInput)).toEqual(["src/main.ts"]);
  });

  it("exempts Codex plans and AGENTS.md from edit-intent blocking (codex adapter)", () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    expect(isEditIntentExemptPath("/home/user/.codex/plans/plan.md")).toBe(true);
    expect(isEditIntentExemptPath("/repo/AGENTS.md")).toBe(true);
  });

  it("does not classify apply_patch as low-risk", () => {
    expect(isLowRiskTool("apply_patch")).toBe(false);
  });
});
