import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { activeSpec } from "../../../src/adapter/spec.js";
import {
  getAgentFrameworkSessionDir,
  sessionCurrentPlanFile,
  sessionPlanFile,
  sessionTranscriptPathSidecar,
  sessionPlanValidationStatusFile,
} from "../../../src/utils/paths.js";

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

function planBody(): string {
  return required.map((heading) => {
    if (heading === "User Goal") return `## ${heading}\n\n> "Create a planfile."`;
    if (heading === "Answered Assumptions") {
      return `## ${heading}\n\n1. The repo path is known. Answer: It is /repo. Source: User text.`;
    }
    if (heading === "Data Flow") {
      return `## ${heading}\n\nInput\n  |\n  v\nPlanfile creator\n  |\n  v\nValidated planfile`;
    }
    if (heading === "Assistant Verification") {
      return `## ${heading}\n\nRun \`${activeSpec().mcpWireName("check")}\` with \`working_dir\` set to \`/repo\`.`;
    }
    if (heading === "Manual User Verification") {
      return `## ${heading}\n\nNo manual user verification is required.`;
    }
    return `## ${heading}\n\nConcrete details for ${heading} with \`src/file.ts\` references.`;
  }).join("\n\n");
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
    let sessionDir = "";
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: process.cwd() });
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
    const start = serverSource.indexOf('server.registerTool(\n  "create_planfile"');
    const end = serverSource.indexOf('server.registerTool(\n  "confirm"', start);
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
    expect(inputInterface).not.toContain("transcriptPath");
  });

  it("does not update current-plan when validation fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    let sessionDir = "";
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: process.cwd() });
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite an existing planfile with the same plan name", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    let sessionDir = "";
    try {
      const transcriptPath = path.join(tempDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");
      sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: process.cwd() });
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
