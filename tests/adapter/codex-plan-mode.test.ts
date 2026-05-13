import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { detectPlanMode } from "../../adapters/codex/plan-mode.js";
import { materializeScenarioEntry } from "../../adapters/codex/scenario-materializer.js";

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
});
