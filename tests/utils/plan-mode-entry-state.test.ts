import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPlanModeTransition,
  computePlanModeTransition,
} from "../../src/utils/plan-mode-entry-state.js";
import {
  buildPendingContextInjections,
  contextInjectionProviders,
} from "../../src/utils/context-injection-providers.js";
import { sessionPlanModeEventsFile, sessionPlanModeStateFile } from "../../src/utils/paths.js";

describe("plan-mode transition state", () => {
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

  it("routes PLANS.md injection through the generic provider registry", () => {
    expect(contextInjectionProviders.map((provider) => provider.id)).toContain(
      "plans-md-plan-mode-entry",
    );
  });

  it("computes inactive-to-active and builds exact PLANS.md pending injection", async () => {
    const plans = "# Planning Contract\n\nFollow this.\n";
    fs.writeFileSync(path.join(projectDir, "PLANS.md"), plans);

    const transition = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      permissionMode: "plan",
    });
    const pending = await buildPendingContextInjections({
      projectDir,
      sourceEvent: "UserPromptSubmit",
      planModeTransition: transition,
    });

    expect(transition.active).toBe(true);
    expect(transition.entered).toBe(true);
    expect(pending).toHaveLength(1);
    expect(pending[0].message).toContain("The session just entered plan mode.");
    expect(pending[0].source_file).toMatchObject({
      kind: "file",
      path: path.join(projectDir, "PLANS.md"),
      content: plans,
    });
    expect(fs.existsSync(sessionPlanModeStateFile(sessionDir))).toBe(false);
  });

  it("commits state and appends an event only on active-state changes", async () => {
    const first = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      permissionMode: "plan",
    });
    await commitPlanModeTransition(sessionDir, first);

    const second = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      permissionMode: "plan",
    });
    await commitPlanModeTransition(sessionDir, second);

    const state = JSON.parse(fs.readFileSync(sessionPlanModeStateFile(sessionDir), "utf-8")) as { active: boolean };
    const events = fs.readFileSync(sessionPlanModeEventsFile(sessionDir), "utf-8").trim().split("\n");
    expect(state.active).toBe(true);
    expect(second.entered).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("updates state to inactive without pending injections", async () => {
    fs.writeFileSync(sessionPlanModeStateFile(sessionDir), JSON.stringify({
      active: true,
      updatedAt: 1,
      lastSource: "UserPromptSubmit",
      permission_mode: "plan",
      detection_source: "hook-input",
    }));

    const transition = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      transcriptPath,
      permissionMode: "default",
    });
    const pending = await buildPendingContextInjections({
      projectDir,
      sourceEvent: "UserPromptSubmit",
      planModeTransition: transition,
    });
    await commitPlanModeTransition(sessionDir, transition);

    expect(transition).toMatchObject({ active: false, entered: false, exited: true });
    expect(pending).toEqual([]);
    const state = JSON.parse(fs.readFileSync(sessionPlanModeStateFile(sessionDir), "utf-8")) as { active: boolean };
    expect(state.active).toBe(false);
  });

  it("tolerates corrupt sidecar state", async () => {
    fs.writeFileSync(sessionPlanModeStateFile(sessionDir), "{not json");
    fs.writeFileSync(path.join(projectDir, "PLANS.md"), "# Planning Contract");

    const transition = await computePlanModeTransition({
      source: "SessionStart",
      sessionDir,
      transcriptPath,
      permissionMode: "plan",
    });
    const pending = await buildPendingContextInjections({
      projectDir,
      sourceEvent: "SessionStart",
      planModeTransition: transition,
    });

    expect(transition.previous).toBeNull();
    expect(transition.entered).toBe(true);
    expect(pending[0].message).toContain("# Planning Contract");
  });
});
