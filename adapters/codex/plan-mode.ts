import * as fs from "fs";
import type { PlanModeDetection, PlanModeDetectionInput } from "../../src/adapter/types.js";
import { detectPermissionPlanMode } from "../../src/utils/plan-mode-detector.js";

function findCodexCollaborationModeInLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line) as {
      type?: unknown;
      payload?: {
        collaboration_mode_kind?: unknown;
        collaboration_mode?: { mode?: unknown };
      };
    };
    const eventKind = parsed.type === "event_msg"
      ? parsed.payload?.collaboration_mode_kind
      : undefined;
    if (typeof eventKind === "string") return eventKind;
    const turnContextMode = parsed.type === "turn_context"
      ? parsed.payload?.collaboration_mode?.mode
      : undefined;
    if (typeof turnContextMode === "string") return turnContextMode;
  } catch {
    // Ignore malformed transcript lines.
  }
  return null;
}

function findCodexCollaborationModeInTranscript(transcriptPath: string): string | null {
  const chunkSize = 64 * 1024;
  let fd: number | undefined;
  try {
    const stats = fs.statSync(transcriptPath);
    fd = fs.openSync(transcriptPath, "r");
    let position = stats.size;
    let carry = "";

    while (position > 0) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      fs.readSync(fd, buffer, 0, readSize, position);
      const content = buffer.toString("utf-8") + carry;
      const lines = content.split("\n");
      carry = lines.shift() ?? "";

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim();
        if (line.length === 0) continue;
        const mode = findCodexCollaborationModeInLine(line);
        if (mode !== null) {
          fs.closeSync(fd);
          fd = undefined;
          return mode;
        }
      }
    }

    const firstLine = carry.trim();
    if (firstLine.length > 0) {
      const mode = findCodexCollaborationModeInLine(firstLine);
      if (mode !== null) return mode;
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return null;
}

function detectionFromCollaborationMode(mode: string): PlanModeDetection {
  return {
    active: mode === "plan",
    mode,
    source: "codex-collaboration-mode",
  };
}

export function detectPlanMode(input: PlanModeDetectionInput): PlanModeDetection {
  if (input.collaborationMode !== undefined) {
    return detectionFromCollaborationMode(input.collaborationMode);
  }

  const collaborationMode = input.transcriptPath
    ? findCodexCollaborationModeInTranscript(input.transcriptPath)
    : null;
  if (collaborationMode !== null) {
    return detectionFromCollaborationMode(collaborationMode);
  }

  const permissionMode = detectPermissionPlanMode(input);
  if (permissionMode !== null) return permissionMode;

  return { active: false, mode: null, source: "none" };
}
