import * as fs from "fs";
import * as path from "path";
import {
  encodeAgentFrameworkProjectDir,
  runtimeRoot,
  sessionDir,
  sessionTranscriptPathSidecar,
} from "../../utils/paths.js";

export async function runTranscriptAgent(transcriptPath?: string): Promise<string> {
  const resolved = transcriptPath ?? resolveFromSidecar();
  if (!fs.existsSync(resolved)) throw new Error(`transcript file does not exist: ${resolved}`);
  const dir = sessionDir(resolved);
  const sidecarPath = sessionTranscriptPathSidecar(dir);
  try {
    if (!fs.existsSync(sidecarPath) || fs.readFileSync(sidecarPath, "utf-8").trim() !== resolved) {
      fs.writeFileSync(sidecarPath, resolved + "\n");
    }
  } catch { /* sidecar best-effort */ }
  return resolved;
}

function resolveFromSidecar(): string {
  const parentDir = path.join(runtimeRoot(), "sessions", encodeAgentFrameworkProjectDir());
  let entries: string[];
  try {
    entries = fs.readdirSync(parentDir);
  } catch {
    throw new Error(`no session directory found at ${parentDir} - has any hook fired yet?`);
  }
  const candidates = entries
    .map((name) => {
      const sidecar = sessionTranscriptPathSidecar(path.join(parentDir, name));
      try {
        const stat = fs.statSync(sidecar);
        return { sidecar, mtimeMs: stat.mtimeMs };
      } catch {
        return undefined;
      }
    })
    .filter((c): c is { sidecar: string; mtimeMs: number } => c !== undefined)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (candidates.length === 0) {
    throw new Error(`no transcript-path.txt sidecar found under ${parentDir}`);
  }
  return fs.readFileSync(candidates[0].sidecar, "utf-8").trim();
}
