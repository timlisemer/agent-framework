import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  sessionCurrentPlanFile,
  sessionPlanFile,
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
      return `## ${heading}\n\nRun \`mcp__agent_framework__check\` with \`working_dir\` set to \`/repo\`.`;
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
    delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
    vi.resetModules();
  });

  it("writes a normalized session planfile, validates it, and records current-plan on PASS", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    try {
      const sessionDir = path.join(tempDir, "session");
      process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent();

      const result = await runCreatePlanfileAgent({
        planName: "created-plan",
        content: `Plan Name: stale-name\n\n${planBody()}\n\nPlanfile Path: /wrong/path.md\nPlan Name: stale-name`,
      });

      const planPath = sessionPlanFile(sessionDir, "created-plan");
      expect(result).toContain(`Created planfile: ${planPath}`);
      expect(result).toContain("- Status: PASS");
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
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not update current-plan when validation fails", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "create-planfile-"));
    try {
      const sessionDir = path.join(tempDir, "session");
      process.env.AGENT_FRAMEWORK_SESSION_DIR = sessionDir;
      const runCreatePlanfileAgent = await loadRunCreatePlanfileAgent("INVALID: Missing concrete file paths.");

      const result = await runCreatePlanfileAgent({
        planName: "failing-plan",
        content: planBody(),
      });

      expect(result).toContain("- Status: FAIL");
      expect(result).toContain("Missing concrete file paths.");
      expect(fs.existsSync(sessionPlanFile(sessionDir, "failing-plan"))).toBe(true);
      expect(fs.existsSync(sessionCurrentPlanFile(sessionDir))).toBe(false);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
