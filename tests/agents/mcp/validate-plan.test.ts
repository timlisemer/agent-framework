import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

function validPlan(): string {
  return required.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Implement validate plan MCP."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n1. The repo path is known. Answer: It is /repo. Source: User text.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nInput\n  |\n  v\nPlan validator\n  |\n  v\nMCP output`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`mcp__agent_framework__check\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nThis section contains concrete repository-specific details for ${heading} with \`src/file.ts\` references.`;
  }).join("\n\n");
}

async function loadRunValidatePlanAgent(stub?: string) {
  vi.resetModules();
  if (stub) {
    process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "plan-validate": stub });
  } else {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
  }
  const mod = await import("../../../src/agents/mcp/validate-plan.js");
  return mod.runValidatePlanAgent;
}

describe("runValidatePlanAgent", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    vi.resetModules();
  });

  it("fails when both inline plan and plan file are provided", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent();
    const result = await runValidatePlanAgent({
      workingDir: process.cwd(),
      plan: "## Plan",
      planFile: "plan.md",
    });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Provide exactly one of plan or plan_file.");
  });

  it("fails when no plan source is provided", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent();
    const result = await runValidatePlanAgent({ workingDir: process.cwd() });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Provide exactly one of plan or plan_file.");
  });

  it("fails when inline plan is empty", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent();
    const result = await runValidatePlanAgent({ workingDir: process.cwd(), plan: "  \n" });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Plan content is empty.");
  });

  it("fails deterministic planning-contract violations", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent("VALID");
    const result = await runValidatePlanAgent({
      workingDir: process.cwd(),
      plan: "## Test Plan\n\nRun tests.",
    });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("generic verification");
  });

  it("passes when the plan-validate LLM returns VALID", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent("VALID");
    const result = await runValidatePlanAgent({
      workingDir: process.cwd(),
      plan: validPlan(),
    });
    expect(result).toContain("- Status: PASS");
    expect(result).toContain("## Reasons\n(none)");
  });

  it("fails with the LLM reason when plan-validate returns INVALID", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent("INVALID: Missing concrete file paths.");
    const result = await runValidatePlanAgent({
      workingDir: process.cwd(),
      plan: validPlan(),
    });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Missing concrete file paths.");
  });

  it("reads plan_file relative to working_dir", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    try {
      fs.writeFileSync(path.join(tempDir, "plan.md"), validPlan());
      const runValidatePlanAgent = await loadRunValidatePlanAgent("VALID");
      const result = await runValidatePlanAgent({
        workingDir: tempDir,
        planFile: "plan.md",
      });
      expect(result).toContain("- Status: PASS");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
