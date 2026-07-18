import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectPlanMode } from "../../adapters/codex/plan-mode.js";
import { codexSpec } from "../../adapters/codex/index.js";
import { detectPlanModeForHook } from "../../src/utils/plan-mode-detector.js";
import type { PlanModeStoredState } from "../../src/utils/plan-mode-entry-state.js";

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

function activePlanModeState(): PlanModeStoredState {
  return {
    active: true,
    updatedAt: Date.now(),
    lastSource: "UserPromptSubmit",
    mode: "plan",
    detection_source: "codex-collaboration-mode",
    deliveredPlansMdHash: null,
    deliveredPlansMdAt: null,
  };
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

  it("finds the latest collaboration marker throughout the transcript", () => {
    withTranscript([
      { type: "event_msg", payload: { collaboration_mode_kind: "plan" } },
      { type: "turn_context", payload: { collaboration_mode: { mode: "default" } } },
      ...Array.from({ length: 120 }, (_, i) => ({
        payload: {
          type: "message",
          role: "assistant",
          content: `filler-${i}-${"x".repeat(600)}`,
        },
      })),
    ], (transcriptPath) => {
      expect(detectPlanMode({ permissionMode: "default", transcriptPath })).toEqual({
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

  it("does not let stored state override direct Codex default mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");

      await expect(detectPlanModeForHook({
        spec: codexSpec,
        permissionMode: "default",
        collaborationMode: "default",
        transcriptPath,
        storedState: activePlanModeState(),
      })).resolves.toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let stored state override Codex transcript default mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
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
        storedState: activePlanModeState(),
      })).resolves.toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not let stored state override a transcript default mode", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({ type: "event_msg", payload: { collaboration_mode_kind: "plan" } }),
          JSON.stringify({ type: "turn_context", payload: { collaboration_mode: { mode: "default" } } }),
          ...Array.from({ length: 120 }, (_, i) => JSON.stringify({
            payload: {
              type: "message",
              role: "assistant",
              content: `filler-${i}-${"x".repeat(600)}`,
            },
          })),
        ].join("\n") + "\n",
      );

      await expect(detectPlanModeForHook({
        spec: codexSpec,
        permissionMode: "default",
        transcriptPath,
        storedState: activePlanModeState(),
      })).resolves.toEqual({
        active: false,
        mode: "default",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses stored active plan mode when Codex has no collaboration marker", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plan-mode-hook-"));
    try {
      const transcriptPath = path.join(dir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, "");

      await expect(detectPlanModeForHook({
        spec: codexSpec,
        permissionMode: "default",
        transcriptPath,
        storedState: activePlanModeState(),
      })).resolves.toEqual({
        active: true,
        mode: "plan",
        source: "codex-collaboration-mode",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
