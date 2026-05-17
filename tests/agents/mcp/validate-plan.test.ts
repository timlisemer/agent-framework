import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sessionPlanValidationStatusFile } from "../../../src/utils/paths.js";

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

function validPlan(planPath = "/tmp/validate-plan.md", planName = "validate-plan"): string {
  const body = required.map((heading) => {
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
  return `Plan Name: ${planName}\n\n${body}\n\nPlanfile Path: ${planPath}\nPlan Name: ${planName}`;
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

async function validatePlanText(plan: string, stub = "VALID"): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
  try {
    const planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, plan.replaceAll("/tmp/validate-plan.md", planPath));
    const runValidatePlanAgent = await loadRunValidatePlanAgent(stub);
    return await runValidatePlanAgent({ workingDir: tempDir, planFile: "plan.md" });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("runValidatePlanAgent", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    vi.resetModules();
  });

  it("fails when no plan source is provided", async () => {
    const runValidatePlanAgent = await loadRunValidatePlanAgent();
    const result = await runValidatePlanAgent({ workingDir: process.cwd(), planFile: "" });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("plan_file is required.");
  });

  it("fails when plan file is empty", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    fs.writeFileSync(path.join(tempDir, "plan.md"), "  \n");
    const runValidatePlanAgent = await loadRunValidatePlanAgent();
    const result = await runValidatePlanAgent({ workingDir: tempDir, planFile: "plan.md" });
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Plan content is empty.");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails deterministic planning-contract violations", async () => {
    const result = await validatePlanText("## Test Plan\n\nRun tests.");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("generic verification");
  });

  it("names unresolved assumption language in deterministic failures", async () => {
    const result = await validatePlanText(
      validPlan().replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Update `src/file.ts` if needed and probably adjust `tests/file.test.ts`.",
      ),
    );
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain('"if needed"');
    expect(result).toContain('"probably"');
  });

  it("allows scanner-prohibited text inside quoted User Goal", async () => {
    const result = await validatePlanText(
      validPlan().replace(
        '> "Implement validate plan MCP."',
        [
          '> "Option A: run make build over 5 days if needed."',
          '> "## Testing is quoted user text."',
        ].join("\n"),
      ),
    );
    expect(result).toContain("- Status: PASS");
  });

  it("still fails scanner-prohibited text outside excluded sections", async () => {
    const result = await validatePlanText(
      validPlan().replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Option A: run make build over 5 days if needed.",
      ),
    );
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Option A");
  });

  it("passes when the plan-validate LLM returns VALID", async () => {
    const result = await validatePlanText(validPlan());
    expect(result).toContain("- Status: PASS");
    expect(result).toContain("## Reasons\n(none)");
  });

  it("accepts Relevant Files and Files That Need Changes as required headings", async () => {
    const result = await validatePlanText(validPlan());
    expect(result).toContain("- Status: PASS");
    expect(result).not.toContain("Extra level-two heading \"## Relevant Files\"");
    expect(result).not.toContain("Extra level-two heading \"## Files That Need Changes\"");
  });

  it("names non-contract level-two headings in deterministic failures", async () => {
    const result = await validatePlanText(validPlan().replace("## Approach", "## Context\n\nContext details.\n\n## Approach"));
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Extra level-two heading \"## Context\"");
  });

  it("fails with the LLM reason when plan-validate returns INVALID", async () => {
    const result = await validatePlanText(validPlan(), "INVALID: Missing concrete file paths.");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Missing concrete file paths.");
  });

  it("rejects vague LLM invalid reasons as malformed", async () => {
    const result = await validatePlanText(validPlan(), "INVALID: The plan does not follow the contract.");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("specific heading, line, or rule");
    expect(result).not.toContain("The plan does not follow the contract.");
  });

  it("surfaces specific LLM invalid reasons", async () => {
    const result = await validatePlanText(validPlan(), "INVALID: Missing required heading \"## Relevant Files\".");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Missing required heading \"## Relevant Files\".");
  });

  it("reads plan_file relative to working_dir", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    try {
      const planPath = path.join(tempDir, "plan.md");
      fs.writeFileSync(planPath, validPlan(planPath));
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

  it("records PASS validation status when session context is available", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    const prevSessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR;
    try {
      const sessionDir = path.join(tempDir, "session");
      process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      const planPath = path.join(tempDir, "plan.md");
      fs.writeFileSync(planPath, validPlan(planPath));
      const runValidatePlanAgent = await loadRunValidatePlanAgent("VALID");
      const result = await runValidatePlanAgent({
        workingDir: tempDir,
        planFile: planPath,
        transcriptPath,
      });
      expect(result).toContain("- Status: PASS");
      const status = JSON.parse(fs.readFileSync(sessionPlanValidationStatusFile(sessionDir), "utf-8"));
      expect(Object.values(status)[0]).toMatchObject({ status: "pass", planPath });
    } finally {
      if (prevSessionDir === undefined) delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
      else process.env.AGENT_FRAMEWORK_SESSION_DIR = prevSessionDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records FAIL validation status when session context is available", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    const prevSessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR;
    try {
      const sessionDir = path.join(tempDir, "session");
      process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      const planPath = path.join(tempDir, "plan.md");
      fs.writeFileSync(planPath, validPlan(planPath));
      const runValidatePlanAgent = await loadRunValidatePlanAgent("INVALID: Missing required heading \"## Relevant Files\".");
      const result = await runValidatePlanAgent({
        workingDir: tempDir,
        planFile: planPath,
        transcriptPath,
      });
      expect(result).toContain("- Status: FAIL");
      const status = JSON.parse(fs.readFileSync(sessionPlanValidationStatusFile(sessionDir), "utf-8"));
      expect(Object.values(status)[0]).toMatchObject({
        status: "fail",
        planPath,
        reasons: ["Missing required heading \"## Relevant Files\"."],
      });
    } finally {
      if (prevSessionDir === undefined) delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
      else process.env.AGENT_FRAMEWORK_SESSION_DIR = prevSessionDir;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
