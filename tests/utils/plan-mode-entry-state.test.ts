import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectPlanModeEntryAndBuildInjection } from "../../src/utils/plan-mode-entry-state.js";
import { sessionPlanModeStateFile } from "../../src/utils/paths.js";

describe("detectPlanModeEntryAndBuildInjection", () => {
  let tempDir: string;
  let sessionDir: string;
  let projectDir: string;
  let transcriptPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-mode-entry-"));
    sessionDir = path.join(tempDir, "session");
    projectDir = path.join(tempDir, "project");
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(transcriptPath, "");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("injects PLANS.md on inactive-to-active transition", async () => {
    fs.writeFileSync(path.join(projectDir, "PLANS.md"), "# Planning Contract\n\nFollow this.");

    const result = await detectPlanModeEntryAndBuildInjection({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "plan",
    });

    expect(result.active).toBe(true);
    expect(result.entered).toBe(true);
    expect(result.message).toContain("The session just entered plan mode.");
    expect(result.message).toContain("# Planning Contract");
    expect(fs.existsSync(sessionPlanModeStateFile(sessionDir))).toBe(true);
  });

  it("does not inject repeatedly while plan mode remains active", async () => {
    fs.writeFileSync(path.join(projectDir, "PLANS.md"), "# Planning Contract");

    await detectPlanModeEntryAndBuildInjection({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "plan",
    });

    const second = await detectPlanModeEntryAndBuildInjection({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "plan",
    });

    expect(second).toEqual({ active: true, entered: false });
  });

  it("updates state to inactive without injecting", async () => {
    fs.writeFileSync(sessionPlanModeStateFile(sessionDir), JSON.stringify({
      active: true,
      updatedAt: 1,
      lastSource: "UserPromptSubmit",
    }));

    const result = await detectPlanModeEntryAndBuildInjection({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "default",
    });

    expect(result).toEqual({ active: false, entered: false });
    const state = JSON.parse(fs.readFileSync(sessionPlanModeStateFile(sessionDir), "utf-8")) as { active: boolean };
    expect(state.active).toBe(false);
  });

  it("tolerates corrupt sidecar state", async () => {
    fs.writeFileSync(sessionPlanModeStateFile(sessionDir), "{not json");
    fs.writeFileSync(path.join(projectDir, "PLANS.md"), "# Planning Contract");

    const result = await detectPlanModeEntryAndBuildInjection({
      source: "SessionStart",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "plan",
    });

    expect(result.entered).toBe(true);
    expect(result.message).toContain("# Planning Contract");
  });

  it("records entered state when PLANS.md cannot be loaded", async () => {
    const result = await detectPlanModeEntryAndBuildInjection({
      source: "SessionStart",
      sessionDir,
      transcriptPath,
      projectDir,
      permissionMode: "plan",
    });

    expect(result).toEqual({ active: true, entered: true });
    const state = JSON.parse(fs.readFileSync(sessionPlanModeStateFile(sessionDir), "utf-8")) as { active: boolean };
    expect(state.active).toBe(true);
  });
});
