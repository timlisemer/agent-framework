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
export async function extractSlugFromSession(transcriptPath: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(transcriptPath, "utf-8");
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
export async function resolvePlanPath(transcriptPath: string): Promise<string | null> {
  const slug = await extractSlugFromSession(transcriptPath);
  if (!slug) return null;

  const planPath = path.join(os.homedir(), ".claude", "plans", `${slug}.md`);

  try {
    await fs.promises.access(planPath);
    return planPath;
  } catch {
    return null;
  }
}

/**
 * Read plan file content.
 * Returns null if plan doesn't exist.
 */
export async function readPlanContent(transcriptPath: string): Promise<string | null> {
  const planPath = await resolvePlanPath(transcriptPath);
  if (!planPath) return null;

  try {
    return await fs.promises.readFile(planPath, "utf-8");
  } catch {
    return null;
  }
}
