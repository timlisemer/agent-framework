import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeSpec } from "../../../src/adapter/spec.js";
import { validPlanFixture } from "../../helpers/plan-fixtures.js";
import {
  getAgentFrameworkSessionDir,
  sessionCurrentPlanFile,
  sessionPlanFile,
  sessionTranscriptPathSidecar,
  sessionPlanValidationStatusFile,
} from "../../../src/utils/paths.js";

function planBody(): string {
  return validPlanFixture({
    planName: "body-only-plan",
    planPath: "/tmp/body-only-plan.md",
    userGoal: `> "Create a planfile."`,
    answeredAssumptions: "1. The repo path is known. Answer: It is /repo. Source: User text.",
    dataFlow: "Input\n  |\n  v\nPlanfile creator\n  |\n  v\nValidated planfile",
    assistantVerification:
      `Run \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\` after each larger code change.`,
    sectionBody: (heading) => `Concrete details for ${heading} with \`src/file.ts\` references.`,
  })
    .replace(/^Plan Name: body-only-plan\n\n/, "")
    .replace(/\n\nPlanfile Path: \/tmp\/body-only-plan\.md\nPlan Name: body-only-plan$/, "");
}

async function loadRunCreatePlanfileAgent(stub = "VALID") {
  vi.resetModules();
  process.env.AGENT_FRAMEWORK_LLM_STUBS = JSON.stringify({ "plan-validate": stub });
  const mod = await import("../../../src/agents/mcp/create-planfile.js");
  return mod.runCreatePlanfileAgent;
}

describe("runCreatePlanfileAgent", () => {
  afterEach(() => {
    delete process.env.AGENT_FRAMEWORK_LLM_STUBS;
    vi.resetModules();
  });

  it("writes a normalized session planfile, validates it, and records current-plan on PASS", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let sessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();

      const result = await runCreatePlanfileAgent({
        planName: "created-plan",
        content: `Plan Name: stale-name\n\n${planBody()}\n\nPlanfile Path: /wrong/path.md\nPlan Name: stale-name`,
      });

      const planPath = sessionPlanFile(sessionDir, "created-plan");
      expect(result).toContain(`Created planfile: ${planPath}`);
      expect(result).toContain("- Status: PASS");
      expect(result).toContain("## Instructions\nNow present the complete contents of the validated planfile inside a whole-message <proposed_plan>...</proposed_plan> block.");
      expect(result).toContain("Do not summarize it or replace it with only the plan name, planfile path, or validation status.");
      expect(result).not.toContain("## Reasons\n(none)");
      const written = fs.readFileSync(planPath, "utf-8");
      expect(written).toMatch(/^Plan Name: created-plan/);
      expect(written).toContain(`Planfile Path: ${planPath}\nPlan Name: created-plan`);
      expect(written).not.toContain("stale-name");
      expect(JSON.parse(fs.readFileSync(sessionCurrentPlanFile(sessionDir), "utf-8"))).toEqual({
        kind: "file",
        path: planPath,
        planName: "created-plan",
      });
      const status = JSON.parse(fs.readFileSync(sessionPlanValidationStatusFile(sessionDir), "utf-8"));
      expect(Object.values(status)[0]).toMatchObject({ status: "pass", planPath });
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses continuation instructions on PASS when continueWorkflow is true", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let sessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();

      const result = await runCreatePlanfileAgent({
        planName: "continue-workflow-plan",
        content: planBody(),
        continueWorkflow: true,
      });

      expect(result).toContain("- Status: PASS");
      expect(result).toContain("## Instructions\nValidation passed. Continue with the next step of the invoking plan workflow instead of presenting the plan now.");
      expect(result).not.toContain("<proposed_plan>");
      expect(result).not.toContain("Do not summarize it or replace it with only the plan name, planfile path, or validation status.");
      expect(fs.existsSync(sessionPlanFile(sessionDir, "continue-workflow-plan"))).toBe(true);
      expect(fs.existsSync(sessionCurrentPlanFile(sessionDir))).toBe(true);
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the active session after a transcript-bound sidecar refresh", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let activeSessionDir = "";
    let siblingSessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const activeTranscriptPath = path.join(tempDir, "active.jsonl");
      const siblingTranscriptPath = path.join(tempDir, "sibling.jsonl");
      fs.writeFileSync(activeTranscriptPath, "");
      fs.writeFileSync(siblingTranscriptPath, "");
      activeSessionDir = getAgentFrameworkSessionDir({ transcriptPath: activeTranscriptPath, projectDir });
      siblingSessionDir = getAgentFrameworkSessionDir({ transcriptPath: siblingTranscriptPath, projectDir });

      const activeSidecar = sessionTranscriptPathSidecar(activeSessionDir);
      const siblingSidecar = sessionTranscriptPathSidecar(siblingSessionDir);
      const older = new Date(Date.now() - 10_000);
      const newer = new Date(Date.now() - 5_000);
      fs.utimesSync(activeSidecar, older, older);
      fs.utimesSync(siblingSidecar, newer, newer);
      expect(getAgentFrameworkSessionDir({ projectDir })).toBe(siblingSessionDir);

      getAgentFrameworkSessionDir({ transcriptPath: activeTranscriptPath, projectDir });
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();

      const result = await runCreatePlanfileAgent({
        planName: "active-session-plan",
        content: planBody(),
      });

      const activePlanPath = sessionPlanFile(activeSessionDir, "active-session-plan");
      const siblingPlanPath = sessionPlanFile(siblingSessionDir, "active-session-plan");
      expect(result).toContain(`Created planfile: ${activePlanPath}`);
      expect(fs.existsSync(activePlanPath)).toBe(true);
      expect(fs.existsSync(siblingPlanPath)).toBe(false);
    } finally {
      if (activeSessionDir) fs.rmSync(activeSessionDir, { recursive: true, force: true });
      if (siblingSessionDir && siblingSessionDir !== activeSessionDir) {
        fs.rmSync(siblingSessionDir, { recursive: true, force: true });
      }
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not expose transcript_path on create_planfile", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('registerTimedTool(\n  "create_planfile"');
    const end = serverSource.indexOf('registerTimedTool(\n  "confirm"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const createPlanfileBlock = serverSource.slice(
      start,
      end,
    );
    const createPlanfileSource = fs.readFileSync(
      path.join(process.cwd(), "src/agents/mcp/create-planfile.ts"),
      "utf-8",
    );
    const inputInterface = createPlanfileSource.match(/export interface CreatePlanfileInput \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(createPlanfileBlock).not.toContain("transcript_path");
    expect(createPlanfileBlock).toContain("continue_workflow");
    expect(createPlanfileBlock).toContain("continueWorkflow: args.continue_workflow");
    expect(createPlanfileBlock).toContain("{ signal }");
    expect(inputInterface).not.toContain("transcriptPath");
    expect(inputInterface).toContain("continueWorkflow?: boolean");
  });

  it("honors cancellation before writing the planfile", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let sessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();
      const controller = new AbortController();
      controller.abort();

      await expect(runCreatePlanfileAgent({
        planName: "cancelled-plan",
        content: planBody(),
      }, { signal: controller.signal })).rejects.toThrow("Operation cancelled");

      expect(fs.existsSync(sessionPlanFile(sessionDir, "cancelled-plan"))).toBe(false);
      expect(fs.existsSync(sessionCurrentPlanFile(sessionDir))).toBe(false);
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not update current-plan when validation fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let sessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent("INVALID: Missing concrete file paths.");

      const result = await runCreatePlanfileAgent({
        planName: "failing-plan",
        content: planBody(),
      });

      expect(result).toContain("- Status: FAIL");
      expect(result).toContain("Missing concrete file paths.");
      expect(result).toContain("Do not call create_planfile again for this plan");
      expect(result).toContain(activeSpec().mcpWireName("validate_plan"));
      expect(fs.existsSync(sessionPlanFile(sessionDir, "failing-plan"))).toBe(true);
      expect(fs.existsSync(sessionCurrentPlanFile(sessionDir))).toBe(false);
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing planfile with the same plan name", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    const previousProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    let sessionDir = "";
    try {
      const projectDir = path.join(tempDir, "project");
      fs.mkdirSync(projectDir);
      process.env.AGENT_FRAMEWORK_PROJECT_DIR = projectDir;
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir });
      const planPath = sessionPlanFile(sessionDir, "existing-plan");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "original planfile");
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();

      await expect(runCreatePlanfileAgent({
        planName: "existing-plan",
        content: planBody(),
      })).rejects.toThrow(/Do not call create_planfile again for this plan/);

      expect(fs.readFileSync(planPath, "utf-8")).toBe("original planfile");
    } finally {
      if (sessionDir) fs.rmSync(sessionDir, { recursive: true, force: true });
      if (previousProjectDir === undefined) {
        delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
      } else {
        process.env.AGENT_FRAMEWORK_PROJECT_DIR = previousProjectDir;
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
