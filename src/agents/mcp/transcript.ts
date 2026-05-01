import * as fs from "fs";
import { sessionDir, sessionTranscriptPathSidecar } from "../../utils/paths.js";

export async function runTranscriptAgent(transcriptPath: string): Promise<string> {
  if (!transcriptPath) throw new Error("transcript_path is required");
  if (!fs.existsSync(transcriptPath)) throw new Error(`transcript file does not exist: ${transcriptPath}`);
  const dir = sessionDir(transcriptPath);
  const sidecarPath = sessionTranscriptPathSidecar(dir);
  try {
    if (!fs.existsSync(sidecarPath) || fs.readFileSync(sidecarPath, "utf-8").trim() !== transcriptPath) {
      fs.writeFileSync(sidecarPath, transcriptPath + "\n");
    }
  } catch { /* sidecar best-effort */ }
  return transcriptPath;
}
