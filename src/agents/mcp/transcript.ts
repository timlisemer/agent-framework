import * as fs from "fs";
import {
  getAgentFrameworkSessionDir,
  sessionTranscriptPathSidecar,
} from "../../utils/paths.js";

export async function runTranscriptAgent(transcriptPath?: string): Promise<string> {
  const dir = getAgentFrameworkSessionDir({ transcriptPath });
  const sidecarPath = sessionTranscriptPathSidecar(dir);
  const resolved = transcriptPath ?? fs.readFileSync(sidecarPath, "utf-8").trim();
  if (!fs.existsSync(resolved)) throw new Error(`transcript file does not exist: ${resolved}`);
  try {
    if (!fs.existsSync(sidecarPath) || fs.readFileSync(sidecarPath, "utf-8").trim() !== resolved) {
      fs.writeFileSync(sidecarPath, resolved + "\n");
    }
  } catch { /* sidecar best-effort */ }
  return resolved;
}
