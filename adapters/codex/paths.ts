/**
 * Codex adapter path conventions.
 *
 * This module owns Codex-specific filesystem literals.
 *
 * @module adapters/codex/paths
 */

import * as os from "os";
import * as path from "path";
import type { AdapterTranscriptFile } from "../../src/adapter/types.js";
import { listJsonlFilesRecursive, readFileHeadBuffer } from "../../src/utils/file-io.js";
import { resolveProjectDirectory } from "../shared/host-context.js";
import { codexEventCwd, codexEventSessionId } from "./transcript-metadata.js";

export function codexSessionsRoot(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

export function projectTranscriptsDir(_absPath?: string): string {
  return codexSessionsRoot();
}

export function projectTranscriptFile(name: string, absPath?: string): string {
  const filename = name.endsWith(".jsonl") ? name : `${name}.jsonl`;
  const matches = listProjectTranscripts(absPath).filter((entry) =>
    path.basename(entry.path) === filename || `${entry.name}.jsonl` === filename
  );
  if (matches.length === 1) return matches[0].path;
  return path.join(projectTranscriptsDir(absPath), filename);
}

export function listProjectTranscripts(absPath?: string): AdapterTranscriptFile[] {
  const root = codexSessionsRoot();
  const projectDir = resolveProjectDirectory({ projectDir: absPath });
  const results: AdapterTranscriptFile[] = [];
  for (const filePath of listJsonlFilesRecursive(root)) {
    const cwd = codexTranscriptCwd(filePath);
    if (cwd !== projectDir) continue;
    results.push({
      name: path.basename(filePath).replace(/\.jsonl$/, ""),
      path: filePath,
    });
  }
  return results;
}

export function codexTranscriptCwd(filePath: string): string | null {
  return firstCodexTranscriptHeadValue(filePath, codexEventCwd);
}

export function codexTranscriptSessionId(filePath: string): string | null {
  return firstCodexTranscriptHeadValue(filePath, codexEventSessionId);
}

function firstCodexTranscriptHeadValue(
  filePath: string,
  extract: (line: string) => string | null
): string | null {
  try {
    const buffer = readFileHeadBuffer(filePath, 64 * 1024);
    if (!buffer) return null;
    const lines = buffer.toString("utf-8").split("\n");
    for (const line of lines.slice(0, 64)) {
      if (!line.trim()) continue;
      const value = extract(line);
      if (value) return value;
    }
    return null;
  } catch {
    return null;
  }
}
