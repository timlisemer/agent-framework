import { afterEach, describe, expect, it } from "vitest";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import {
  formatSessionPlanfilesForFeedback,
  getPathToPlanfile,
  isSessionPlanfilePath,
  listSessionPlanfiles,
  validatePlanName,
} from "../../src/utils/planfile.js";
import { sessionPlanFile, sessionPlansDir } from "../../src/utils/paths.js";

describe("planfile utilities", () => {
  const oldAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
  const oldPlanDir = process.env.AGENT_FRAMEWORK_PLAN_DIR;

  afterEach(() => {
    process.env.AGENT_FRAMEWORK_ADAPTER = oldAdapter;
    if (oldPlanDir === undefined) delete process.env.AGENT_FRAMEWORK_PLAN_DIR;
    else process.env.AGENT_FRAMEWORK_PLAN_DIR = oldPlanDir;
  });

  it("returns native adapter planfile paths", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    process.env.AGENT_FRAMEWORK_PLAN_DIR = "/tmp/native-plans";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planfile-"));
    const transcriptPath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, JSON.stringify({ slug: "native-plan" }) + "\n");
    const result = await getPathToPlanfile({ transcriptPath, sessionDir: "/tmp/session", planName: "native-plan" });
    expect(result).toBe("/tmp/native-plans/native-plan.md");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns session fallback paths for non-native adapters", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    const sessionDir = "/tmp/agent-session";
    await expect(getPathToPlanfile({
      transcriptPath: "/tmp/transcript.jsonl",
      sessionDir,
      planName: "my-plan",
    })).resolves.toBe(sessionPlanFile(sessionDir, "my-plan"));
  });

  it("rejects invalid names", () => {
    expect(() => validatePlanName("Bad_Name")).toThrow(/Invalid plan name/);
  });

  it("rejects traversal in plan names", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    await expect(getPathToPlanfile({
      transcriptPath: "/tmp/transcript.jsonl",
      sessionDir: "/tmp/session",
      planName: "../escape",
    })).rejects.toThrow(/Invalid plan name/);
  });

  it("identifies session planfile paths", () => {
    expect(isSessionPlanfilePath("/tmp/session/plans/my-plan.md", "/tmp/session")).toBe(true);
    expect(isSessionPlanfilePath("/tmp/session/plans/Bad.md", "/tmp/session")).toBe(false);
    expect(isSessionPlanfilePath("/tmp/session/other/my-plan.md", "/tmp/session")).toBe(false);
  });

  it("lists only accepted session planfiles for feedback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "planfile-list-"));
    const plansDir = sessionPlansDir(dir);
    fs.mkdirSync(plansDir, { recursive: true });
    const accepted = sessionPlanFile(dir, "accepted-plan");
    const other = sessionPlanFile(dir, "other-plan");
    fs.writeFileSync(accepted, "");
    fs.writeFileSync(other, "");
    fs.writeFileSync(path.join(plansDir, "Bad.md"), "");
    fs.writeFileSync(path.join(plansDir, "notes.txt"), "");

    expect(listSessionPlanfiles(dir)).toEqual([accepted, other]);
    const feedback = formatSessionPlanfilesForFeedback(dir);
    expect(feedback).toContain(`Session planfiles directory: ${plansDir}`);
    expect(feedback).toContain(accepted);
    expect(feedback).toContain(other);
    expect(feedback).not.toContain("Bad.md");
    expect(feedback).not.toContain("notes.txt");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
