import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validPlanFixture } from "../../helpers/plan-fixtures.js";

function validPlan(planPath: string): string {
  return validPlanFixture({
    planPath,
    planName: "feedback-plan",
    userGoal: `> "Fix plan validation feedback."`,
    answeredAssumptions: `- The plan path is known; answer: ${planPath}; source: hook input.`,
    dataFlow: "Hook failure\n  |\n  v\nPlan validator\n  |\n  v\nPath-specific feedback",
    sectionBody: (heading) => `Concrete implementation details for ${heading} in \`src/file.ts\`.`,
  });
}

async function loadCheckPlanIntent(stub: string) {
  vi.resetModules();
  process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "plan-validate": stub });
  const mod = await import("../../../src/agents/hooks/plan-validate.js");
  return mod.checkPlanIntent;
}

describe("checkPlanIntent planfile remediation feedback", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    vi.resetModules();
  });

  it("appends exact planfile iteration workflow to DRIFT feedback", async () => {
    const planPath = path.join(process.cwd(), ".tmp-session", "plans", "feedback-plan.md");
    const checkPlanIntent = await loadCheckPlanIntent("DRIFT: Missing concrete helper signature.");

    const result = await checkPlanIntent(
      null,
      "Write",
      { content: validPlan(planPath) },
      "USER: Fix plan validation feedback.",
      process.cwd(),
      "Stop",
      "exit",
      planPath,
    );

    expect(result.approved).toBe(false);
    expect(result.reason).toContain("Missing concrete helper signature.");
    expect(result.reason).toContain(`Iterate on the planfile using`);
    expect(result.reason).toContain(planPath);
  });
});
