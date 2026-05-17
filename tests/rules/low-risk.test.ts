import { describe, expect, it } from "vitest";
import { lowRiskRule } from "../../src/rules/low-risk.js";
import type { RuleContext } from "../../src/rules/types.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    toolName: "mcp-create_planfile",
    projectDir: "/repo",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state: sessionStateDefaults(),
    stateManager: {} as RuleContext["stateManager"],
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
    ...overrides,
  };
}

describe("lowRiskRule", () => {
  it("denies create_planfile outside plan mode", async () => {
    const result = await lowRiskRule.check(makeCtx());
    expect(result).toEqual({
      fastDeny: "create_planfile is only available while plan mode is active.",
    });
  });

  it("allows create_planfile as low-risk while plan mode is active", async () => {
    const result = await lowRiskRule.check(makeCtx({
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
    }));
    expect(result).toEqual({ fastAllow: "Low-risk tool auto-approval" });
  });
});
