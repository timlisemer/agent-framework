/**
 * Codex adapter path conventions.
 *
 * This module owns Codex-specific filesystem literals.
 *
 * @module adapters/codex/paths
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type { AdapterTranscriptFile } from "../../src/adapter/types.js";
import { readFileHeadBuffer } from "../../src/utils/file-io.js";

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
  if (!fs.existsSync(root)) return [];

  const projectDir = path.resolve(
    absPath ??
    process.env.AGENT_FRAMEWORK_PROJECT_DIR ??
    process.env.CLAUDE_PROJECT_DIR ??
    process.cwd(),
  );
  const results: AdapterTranscriptFile[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const cwd = codexTranscriptCwd(fullPath);
      if (cwd !== projectDir) continue;
      results.push({
        name: entry.name.replace(/\.jsonl$/, ""),
        path: fullPath,
      });
    }
  };
  visit(root);
  return results;
}

function codexTranscriptCwd(filePath: string): string | null {
  try {
    const buffer = readFileHeadBuffer(filePath, 64 * 1024);
    if (!buffer) return null;
    const lines = buffer.toString("utf-8").split("\n");
    for (const line of lines.slice(0, 64)) {
      if (!line.trim()) continue;
      const cwd = codexEventCwd(line);
      if (cwd) return cwd;
    }
    return null;
  } catch {
    return null;
  }
}

function codexEventCwd(line: string): string | null {
  try {
    const event = JSON.parse(line) as {
      cwd?: unknown;
      payload?: { cwd?: unknown };
    };
    const cwd = typeof event.payload?.cwd === "string"
      ? event.payload.cwd
      : typeof event.cwd === "string"
        ? event.cwd
        : null;
    return cwd ? path.resolve(cwd) : null;
  } catch {
    return null;
  }
}
