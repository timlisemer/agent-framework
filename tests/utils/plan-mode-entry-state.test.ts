import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  commitPlanModeTransition,
  computePlanModeTransition,
  readPlanModeStoredState,
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

  it("routes planning-contract injection through the generic provider registry", () => {
    expect(contextInjectionProviders.map((provider) => provider.id)).toContain(
      "plans-md-plan-mode-entry",
    );
  });

  it("keeps planning-contract injection provider registered but temporarily disabled", async () => {
    const transition = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
    });
    const pending = await buildPendingContextInjections({
      projectDir,
      sourceEvent: "UserPromptSubmit",
      planModeTransition: transition,
    });

    expect(transition.active).toBe(true);
    expect(transition.entered).toBe(true);
    expect(pending).toEqual([]);
    expect(fs.existsSync(sessionPlanModeStateFile(sessionDir))).toBe(false);
  });

  it("commits state and appends an event only on active-state changes", async () => {
    const first = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
    });
    await commitPlanModeTransition(sessionDir, first);

    const second = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
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
      mode: "plan",
      detection_source: "hook-permission-mode",
      deliveredPlansMdHash: null,
      deliveredPlansMdAt: null,
    }));

    const transition = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      detection: { active: false, mode: "default", source: "hook-permission-mode" },
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
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
    });
    const pending = await buildPendingContextInjections({
      projectDir,
      sourceEvent: "SessionStart",
      planModeTransition: transition,
    });

    expect(transition.previous).toBeNull();
    expect(transition.entered).toBe(true);
    expect(pending).toEqual([]);
  });

  it("reads committed plan-mode state and returns null for invalid state", async () => {
    const transition = await computePlanModeTransition({
      source: "UserPromptSubmit",
      sessionDir,
      detection: { active: true, mode: "plan", source: "hook-permission-mode" },
    });
    await commitPlanModeTransition(sessionDir, transition);

    await expect(readPlanModeStoredState(sessionDir)).resolves.toMatchObject({
      active: true,
      mode: "plan",
      detection_source: "hook-permission-mode",
    });

    fs.writeFileSync(sessionPlanModeStateFile(sessionDir), "{not json");
    await expect(readPlanModeStoredState(sessionDir)).resolves.toBeNull();
  });
});
