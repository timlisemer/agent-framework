import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSpec } from "../../../src/adapter/spec.js";

const required = [
  "User Goal",
  "Answered Assumptions",
  "Goal In My Words",
  "Approach",
  "Data Flow",
  "Files To Create",
  "Files To Modify",
  "Implementation Order",
  "Assistant Verification",
  "Manual User Verification",
  "Approaches Decided Against",
  "Possible Future Followups",
  "Relevant Files",
  "Files That Need Changes",
];

function validPlan(planPath: string): string {
  const body = required.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Fix plan validation feedback."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n- The plan path is known; answer: ${planPath}; source: hook input.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nHook failure\n  |\n  v\nPlan validator\n  |\n  v\nPath-specific feedback`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nConcrete implementation details for ${heading} in \`src/file.ts\`.`;
  }).join("\n\n");
  return `Plan Name: feedback-plan\n\n${body}\n\nPlanfile Path: ${planPath}\nPlan Name: feedback-plan`;
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
