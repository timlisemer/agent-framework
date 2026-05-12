import * as fs from "fs";
import type { PlanModeDetection, PlanModeDetectionInput } from "../../src/adapter/types.js";

function readTranscriptTail(transcriptPath: string): string {
  let fd: number | undefined;
  try {
    const stats = fs.statSync(transcriptPath);
    const readSize = Math.min(stats.size, 50 * 1024);
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(readSize);
    fs.readSync(fd, buffer, 0, readSize, Math.max(0, stats.size - readSize));
    fs.closeSync(fd);
    fd = undefined;
    return buffer.toString("utf-8");
  } catch {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
    return "";
  }
}

function findCodexCollaborationMode(content: string): string | null {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as {
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
  }
  return null;
}

function findPermissionMode(content: string): string | null {
  const pattern = /"permissionMode"\s*:\s*"([^"]+)"/g;
  let lastValue: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) {
    lastValue = match[1];
  }
  return lastValue;
}

export function detectPlanMode(input: PlanModeDetectionInput): PlanModeDetection {
  const tail = input.transcriptPath ? readTranscriptTail(input.transcriptPath) : "";
  const collaborationMode = tail ? findCodexCollaborationMode(tail) : null;
  if (collaborationMode !== null) {
    return {
      active: collaborationMode === "plan",
      mode: collaborationMode,
      source: "codex-collaboration-mode",
    };
  }

  if (input.permissionMode !== undefined) {
    return {
      active: input.permissionMode === "plan",
      mode: input.permissionMode,
      source: "hook-permission-mode",
    };
  }

  const transcriptPermissionMode = tail ? findPermissionMode(tail) : null;
  if (transcriptPermissionMode !== null) {
    return {
      active: transcriptPermissionMode === "plan",
      mode: transcriptPermissionMode,
      source: "transcript-permission-mode",
    };
  }

  return { active: false, mode: null, source: "none" };
}
