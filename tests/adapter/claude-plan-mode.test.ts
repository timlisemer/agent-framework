import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectPlanMode } from "../../adapters/claude/plan-mode.js";

describe("Claude plan-mode detection", () => {
  it("uses hook permission mode first", () => {
    expect(detectPlanMode({ permissionMode: "plan" })).toEqual({
      active: true,
      mode: "plan",
      source: "hook-permission-mode",
    });
  });

  it("falls back to transcript permission mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-plan-mode-"));
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({ permissionMode: "plan" }) + "\n" +
          JSON.stringify({ permissionMode: "default" }) + "\n",
      );
      expect(detectPlanMode({ transcriptPath })).toEqual({
        active: false,
        mode: "default",
        source: "transcript-permission-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
