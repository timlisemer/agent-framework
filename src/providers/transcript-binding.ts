import fs from "node:fs";
import path from "node:path";
import { fileMtimeMs, listJsonlFilesRecursive } from "../utils/file-io.js";

export type TranscriptBindingCandidate = {
  sessionId: string;
  workingDir: string | null;
};

export function resolveTranscriptBinding(input: {
  explicitPath?: string | null;
  sessionId?: string | null;
  transcriptsRoot?: string | null;
  workingDir?: string | null;
  missingMtimeMs?: number;
  matches(filePath: string, candidate: TranscriptBindingCandidate): boolean;
}): string | null {
  if (input.explicitPath && fs.existsSync(input.explicitPath)) return input.explicitPath;
  const sessionId = input.sessionId;
  if (!sessionId || !input.transcriptsRoot || !fs.existsSync(input.transcriptsRoot)) return null;

  const workingDir = input.workingDir ? path.resolve(input.workingDir) : null;
  const missingMtimeMs = input.missingMtimeMs ?? -1;
  return listJsonlFilesRecursive(input.transcriptsRoot)
    .sort((left, right) => fileMtimeMs(right, missingMtimeMs) - fileMtimeMs(left, missingMtimeMs))
    .find((filePath) =>
      input.matches(filePath, {
        sessionId,
        workingDir,
      })
    ) ?? null;
}
