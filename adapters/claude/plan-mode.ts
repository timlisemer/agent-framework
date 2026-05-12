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
  if (input.permissionMode !== undefined) {
    return {
      active: input.permissionMode === "plan",
      mode: input.permissionMode,
      source: "hook-permission-mode",
    };
  }

  const content = input.transcriptPath ? readTranscriptTail(input.transcriptPath) : "";
  const transcriptPermissionMode = content ? findPermissionMode(content) : null;
  if (transcriptPermissionMode !== null) {
    return {
      active: transcriptPermissionMode === "plan",
      mode: transcriptPermissionMode,
      source: "transcript-permission-mode",
    };
  }

  return { active: false, mode: null, source: "none" };
}
