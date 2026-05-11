import { describe, it, expect } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";

describe("codexEncoder", () => {
  it("emits Codex PreToolUse deny JSON", () => {
    const out = codexEncoder.encodePreToolUseDeny("blocked");
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "blocked",
      },
    });
  });

  it("emits Codex PermissionRequest deny JSON", () => {
    const out = codexEncoder.encodePermissionRequestDeny?.("no");
    expect(out?.exitCode).toBe(0);
    expect(JSON.parse(out?.stdout ?? "")).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "deny", message: "no" },
      },
    });
  });

  it("emits Codex Stop continuation JSON", () => {
    const out = codexEncoder.encodeStopBlock("continue with tests");
    expect(JSON.parse(out.stdout)).toEqual({
      decision: "block",
      reason: "continue with tests",
    });
  });

  it("emits Codex context injection JSON", () => {
    const out = codexEncoder.encodeContext?.("UserPromptSubmit", "read PLANS.md");
    expect(out?.exitCode).toBe(0);
    expect(JSON.parse(out?.stdout ?? "")).toEqual({
      systemMessage: "read PLANS.md",
    });
  });
});
