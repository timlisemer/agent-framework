import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectPlanMode } from "../../adapters/codex/plan-mode.js";
import { codexSpec } from "../../adapters/codex/index.js";
import { materializeScenarioEntry } from "../../adapters/codex/scenario-materializer.js";
import { detectPlanModeForHook } from "../../src/utils/plan-mode-detector.js";
import { sessionPlanModeStateFile } from "../../src/utils/paths.js";

function withTranscript(lines: unknown[], fn: (filePath: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-"));
  try {
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
    fn(filePath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function seedActivePlanModeSidecar(sessionDir: string): void {
  fs.writeFileSync(
    sessionPlanModeStateFile(sessionDir),
    JSON.stringify({
      active: true,
      updatedAt: Date.now(),
      lastSource: "UserPromptSubmit",
      mode: "plan",
      detection_source: "codex-collaboration-mode",
      deliveredPlansMdHash: null,
      deliveredPlansMdAt: null,
    }) + "\n",
  );
}

describe("Codex plan-mode detection", () => {
  it("uses event_msg collaboration mode before permission fallback", () => {
    withTranscript([
      { permissionMode: "default" },
      { type: "event_msg", payload: { collaboration_mode_kind: "plan" } },
    ], (transcriptPath) => {
      expect(detectPlanMode({ permissionMode: "default", transcriptPath })).toEqual({
        active: true,
        mode: "plan",
        source: "codex-collaboration-mode",
      });
    });
  });

  it("uses direct collaboration mode before permission fallback", () => {
    expect(detectPlanMode({ permissionMode: "default", collaborationMode: "plan" })).toEqual({
      active: true,
      mode: "plan",
      source: "codex-collaboration-mode",
    });
    expect(detectPlanMode({ permissionMode: "plan", collaborationMode: "default" })).toEqual({
      active: false,
      mode: "default",
      source: "codex-collaboration-mode",
    });
  });

  it("reads real Codex task_started collaboration mode markers", () => {
    withTranscript([
      {
        type: "event_msg",
        payload: { type: "task_started", collaboration_mode_kind: "plan" },
      },
    ], (transcriptPath) => {
      expect(detectPlanMode({ permissionMode: "default", transcriptPath })).toEqual({
        active: true,
        mode: "plan",
        source: "codex-collaboration-mode",
      });
    });
  });

  it("uses turn_context collaboration mode before permission fallback", () => {
    withTranscript([
      { permissionMode: "plan" },
      { type: "turn_context", payload: { collaboration_mode: { mode: "default" } } },
    ], (transcriptPath) => {
      expect(detectPlanMode({ permissionMode: "plan", transcriptPath })).toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    });
  });

  it("uses the latest transcript collaboration marker", () => {
    withTranscript([
      { type: "event_msg", payload: { collaboration_mode_kind: "plan" } },
      { type: "turn_context", payload: { collaboration_mode: { mode: "default" } } },
    ], (transcriptPath) => {
      expect(detectPlanMode({ transcriptPath })).toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    });
  });

  it("falls back to hook permission mode and transcript permission mode", () => {
    expect(detectPlanMode({ permissionMode: "plan" })).toEqual({
      active: true,
      mode: "plan",
      source: "hook-permission-mode",
    });
    withTranscript([{ permissionMode: "plan" }], (transcriptPath) => {
      expect(detectPlanMode({ transcriptPath })).toEqual({
        active: true,
        mode: "plan",
        source: "transcript-permission-mode",
      });
    });
  });

  it("materializes Codex collaboration-mode markers for scenarios", () => {
    const lines = materializeScenarioEntry(
      { role: "user", content: "plan please" },
      {
        sessionId: "session",
        cwd: "/tmp/project",
        permissionMode: "default",
        codexCollaborationMode: "plan",
        prevUuid: null,
        baseTs: 0,
      },
    );
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0].jsonl)).toMatchObject({
      type: "event_msg",
      payload: { collaboration_mode_kind: "plan" },
    });
    expect(JSON.parse(lines[1].jsonl)).toMatchObject({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "plan" } },
    });
  });

  it("materializes Codex default collaboration-mode markers for scenarios", () => {
    const lines = materializeScenarioEntry(
      { role: "user", content: "implement now" },
      {
        sessionId: "session",
        cwd: "/tmp/project",
        permissionMode: "default",
        codexCollaborationMode: "default",
        prevUuid: null,
        baseTs: 0,
      },
    );
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0].jsonl)).toMatchObject({
      type: "event_msg",
      payload: { collaboration_mode_kind: "default" },
    });
    expect(JSON.parse(lines[1].jsonl)).toMatchObject({
      type: "turn_context",
      payload: { collaboration_mode: { mode: "default" } },
    });
  });

  it("does not let a stale sidecar override direct Codex default mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const sessionDir = path.join(dir, "session");
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(transcriptPath, "");
      seedActivePlanModeSidecar(sessionDir);

      await expect(detectPlanModeForHook({
        spec: codexSpec,
        permissionMode: "default",
        collaborationMode: "default",
        transcriptPath,
        sessionDir,
      })).resolves.toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let a stale sidecar override Codex transcript default mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const sessionDir = path.join(dir, "session");
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.mkdirSync(sessionDir, { recursive: true });
      seedActivePlanModeSidecar(sessionDir);
      fs.writeFileSync(
        transcriptPath,
        JSON.stringify({
          type: "turn_context",
          payload: { collaboration_mode: { mode: "default" } },
        }) + "\n",
      );

      await expect(detectPlanModeForHook({
        spec: codexSpec,
        permissionMode: "default",
        transcriptPath,
        sessionDir,
      })).resolves.toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
