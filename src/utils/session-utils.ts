/**
 * Session Utilities - Plan File Resolution
 *
 * Claude Code stores session metadata in JSONL files at:
 *   ~/.claude/projects/{encoded-path}/agent-{id}.jsonl
 *
 * Each JSONL entry contains a `slug` field that maps to:
 *   ~/.claude/plans/{slug}.md
 *
 * Example:
 *   Transcript: ~/.claude/projects/-home-tim-Coding-foo/abc123.jsonl
 *   Entry contains: {"slug": "woolly-swinging-neumann", ...}
 *   Plan file: ~/.claude/plans/woolly-swinging-neumann.md
 *
 * @module session-utils
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

interface SessionMetadata {
  slug?: string;
}

/**
 * Extract the slug from a session JSONL file.
 * Reads the first few lines to find the slug field.
 */
export function extractSlugFromSession(transcriptPath: string): string | null {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean).slice(0, 10);

    for (const line of lines) {
      try {
        const entry: SessionMetadata = JSON.parse(line);
        if (entry.slug) {
          return entry.slug;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Resolve the plan file path from transcript path.
 * Returns null if no plan exists for this session.
 */
export function resolvePlanPath(transcriptPath: string): string | null {
  const slug = extractSlugFromSession(transcriptPath);
  if (!slug) return null;

  const planPath = path.join(os.homedir(), ".claude", "plans", `${slug}.md`);

  if (fs.existsSync(planPath)) {
    return planPath;
  }
  return null;
}

/**
 * Read plan file content.
 * Returns null if plan doesn't exist.
 */
export function readPlanContent(transcriptPath: string): string | null {
  const planPath = resolvePlanPath(transcriptPath);
  if (!planPath) return null;

  try {
    return fs.readFileSync(planPath, "utf-8");
  } catch {
    return null;
  }
}
