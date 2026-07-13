/**
 * Claude adapter path conventions.
 *
 * This module owns Claude-specific filesystem literals and project encoding.
 *
 * @module adapters/claude/paths
 */

import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import type { AdapterTranscriptFile } from "../../src/adapter/types.js";
import { resolveProjectDirectory } from "../shared/host-context.js";

/**
 * ~/.claude directory.
 */
export function claudeRoot(): string {
  return path.join(os.homedir(), ".claude");
}

/**
 * ~/.claude/projects directory.
 */
export function claudeProjectsRoot(): string {
  return path.join(claudeRoot(), "projects");
}

/**
 * Encode a project root path into the format Claude Code uses for its
 * ~/.claude/projects/ directory names. Replaces both / and _ with - and
 * keeps the leading -.
 *
 * Example: /home/user/my_project -> -home-user-my-project
 */
export function encodeClaudeProjectDir(absPath?: string): string {
  const projectDir = resolveProjectDirectory({ projectDir: absPath });
  return projectDir.replace(/[/_]/g, "-");
}

/**
 * The ~/.claude/projects/<encoded>/ directory for a given project path.
 */
export function projectTranscriptsDir(absPath?: string): string {
  return path.join(claudeProjectsRoot(), encodeClaudeProjectDir(absPath));
}

/**
 * Absolute path to a specific Claude Code transcript file.
 */
export function projectTranscriptFile(name: string, absPath?: string): string {
  return path.join(projectTranscriptsDir(absPath), `${name}.jsonl`);
}

export function listProjectTranscripts(absPath?: string): AdapterTranscriptFile[] {
  const dir = projectTranscriptsDir(absPath);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith(".jsonl"))
    .map((entry) => ({
      name: entry.replace(/\.jsonl$/, ""),
      path: path.join(dir, entry),
    }));
}
