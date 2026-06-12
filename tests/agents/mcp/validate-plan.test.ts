import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeSpec } from "../../../src/adapter/spec.js";
import { getAgentFrameworkSessionDir, sessionPlanValidationStatusFile } from "../../../src/utils/paths.js";
import { hashPlanContent, planValidationStatusKey } from "../../../src/utils/plan-validation-status.js";
import { validPlanFixture } from "../../helpers/plan-fixtures.js";

function validPlan(planPath = "/tmp/validate-plan.md", planName = "validate-plan"): string {
  return validPlanFixture({
    planPath,
    planName,
    userGoal: `> "Implement validate plan MCP."`,
    answeredAssumptions: "1. The repo path is known. Answer: It is /repo. Source: User text.",
    dataFlow: "Input\n  |\n  v\nPlan validator\n  |\n  v\nMCP output",
    assistantVerification: `Run \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\` after each larger code change.`,
    sectionBody: (heading) =>
      `This section contains concrete repository-specific details for ${heading} with \`src/file.ts\` references.`,
  });
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

async function validatePlanText(plan: string, stub = "VALID", continueWorkflow = false): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
  try {
    const planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, plan.replaceAll("/tmp/validate-plan.md", planPath));
    const runValidatePlanAgent = await loadRunValidatePlanAgent(stub);
    return await runValidatePlanAgent({ workingDir: tempDir, planFile: "plan.md", continueWorkflow });
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
    expect(result).toContain("Iterate on the planfile using");
    expect(result).toContain(path.join(tempDir, "plan.md"));
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fails deterministic planning-contract violations", async () => {
    const result = await validatePlanText("## Test Plan\n\nRun tests.");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("generic verification");
  });

  it("prints planfile iteration workflow once for multiple deterministic violations", async () => {
    const plan = validPlan()
      .replace("## Files To Modify", "## Files Modified")
      .replace("## Approach", "## Context\n\nContext details.\n\n## Approach");
    const result = await validatePlanText(plan);
    const planPath = result.match(/for (\/tmp\/validate-plan-[^ ]+\/plan\.md) until it passes/)?.[1];
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain('Extra level-two heading "## Context" is not in the required final-plan structure.');
    expect(result).toContain('Missing required heading "## Files To Modify".');
    expect(result).toContain(`using ${activeSpec().mcpWireName("validate_plan")}`);
    expect(planPath).toBeTruthy();
    expect(result).toContain(`for ${planPath} until it passes`);
    expect(result).toContain("the named planfile is the planning surface");
    expect(result).toContain("this is the required remediation path, not an implementation edit");
    const workflowMatches = result.match(/Iterate on the planfile using/g) ?? [];
    expect(workflowMatches).toHaveLength(1);
  });

  it("accumulates all deterministic violations before the LLM fallback", async () => {
    const plan = validPlan()
      .replace("## Files To Modify", "## Files Modified")
      .replace(
        "This section contains concrete repository-specific details for Approach with `src/file.ts` references.",
        "Option A: run make build over 5 days if needed.",
      );
    const result = await validatePlanText(
      plan,
      "INVALID: LLM fallback should not run when deterministic violations exist.",
    );
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Option A");
    expect(result).toContain("Missing required heading \"## Files To Modify\".");
    expect(result).not.toContain("LLM fallback should not run");
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

  it("passes Assistant Verification that uses scenario MCPs and the check MCP as shell-check replacement", async () => {
    const assistantVerification = [
      "## Assistant Verification",
      "",
      "Run `mcp__agent_framework__scenario_tester` with `working_dir` set to `/repo` and `scenario_name` set to `appeal-overturns-tool-approve-deny-when-user-literally-named-just-build`.",
      "",
      "Run `mcp__agent_framework__check` with `working_dir` set to `/repo` after each larger code change. Treat this MCP as the repository-level replacement for `cargo check`, `npm run check`, and other language-specific shell checks.",
    ].join("\n");
    const result = await validatePlanText(
      validPlan().replace(
        /## Assistant Verification[\s\S]*?(?=\n\n## Manual User Verification)/,
        assistantVerification,
      ),
    );
    expect(result).toContain("- Status: PASS");
  });

  it("reports the complete deterministic Assistant Verification failure before LLM fallback", async () => {
    const result = await validatePlanText(
      validPlan().replace(
        /## Assistant Verification[\s\S]*?(?=\n\n## Manual User Verification)/,
        "## Assistant Verification\n\nAssistant Verification must use the agent-framework check MCP with the repository working_dir.",
      ),
      "INVALID: Assistant Verification must state `mcp__agent_framework__check` is run with `working_dir` after each larger code change, not only as a single final check.",
    );
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain(`Assistant Verification must state \`${activeSpec().mcpWireName("check")}\` is run with repository \`working_dir\` after each larger code change.`);
    expect(result).not.toContain("not only as a single final check");
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
    expect(result).toContain("## Instructions\nNow present the complete contents of the validated planfile inside a whole-message <proposed_plan>...</proposed_plan> block.");
    expect(result).toContain("Do not summarize it or replace it with only the plan name, planfile path, or validation status.");
    expect(result).not.toContain("## Reasons\n(none)");
  });

  it("uses continuation instructions on PASS when continueWorkflow is true", async () => {
    const result = await validatePlanText(validPlan(), "VALID", true);
    expect(result).toContain("- Status: PASS");
    expect(result).toContain("## Instructions\nValidation passed. Continue with the next step of the invoking plan workflow instead of presenting the plan now.");
    expect(result).not.toContain("<proposed_plan>");
    expect(result).not.toContain("Do not summarize it or replace it with only the plan name, planfile path, or validation status.");
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

  it("surfaces helper reuse invalid reasons", async () => {
    const result = await validatePlanText(validPlan(), "INVALID: Missed chance to use existing helper `src/utils/file-io.ts` for repeated file reads.");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("Missed chance to use existing helper `src/utils/file-io.ts` for repeated file reads.");
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

  it("exposes and forwards continue_workflow in the validate_plan MCP registration", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('registerTimedTool(\n  "validate_plan"');
    const end = serverSource.indexOf('registerTimedTool(\n  "create_planfile"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const validatePlanBlock = serverSource.slice(start, end);

    expect(validatePlanBlock).toContain("continue_workflow");
    expect(validatePlanBlock).toContain("continueWorkflow: args.continue_workflow");
  });

  it("records PASS validation status when session context is available", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    let sessionDir = "";
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
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
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records FAIL validation status when session context is available", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-"));
    let sessionDir = "";
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
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
      });
      expect((Object.values(status)[0] as { reasons: string[] }).reasons[0]).toContain("Missing required heading \"## Relevant Files\".");
      expect((Object.values(status)[0] as { reasons: string[] }).reasons[0]).not.toContain("Iterate on the planfile using");
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("records validation status in the active session when transcript_path is omitted", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "validate-plan-session-"));
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      const planPath = path.join(tempDir, "plan.md");
      const plan = validPlan(planPath);
      fs.writeFileSync(transcriptPath, "");
      fs.writeFileSync(planPath, plan);
      const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });

      const runValidatePlanAgent = await loadRunValidatePlanAgent("VALID");
      const result = await runValidatePlanAgent({
        workingDir: tempDir,
        planFile: "plan.md",
      });

      expect(result).toContain("- Status: PASS");
      const statusStore = JSON.parse(fs.readFileSync(sessionPlanValidationStatusFile(sessionDir), "utf-8"));
      expect(statusStore[planValidationStatusKey(planPath, hashPlanContent(plan))]).toMatchObject({
        status: "pass",
        planPath,
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
