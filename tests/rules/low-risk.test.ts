import { describe, expect, it } from "vitest";
import { lowRiskRule } from "../../src/rules/low-risk.js";
import { sessionStateDefaults } from "../../src/utils/session-store.js";
import { makeRuleContext } from "../helpers/rule-context.js";

function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
  return makeRuleContext({
    toolName: "mcp-create_planfile",
    projectDir: "/repo",
    transcriptPath: "/tmp/transcript.jsonl",
    sessionDir: "/tmp/session",
    sessionId: "session",
    state: sessionStateDefaults(),
    ...overrides,
  });
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
