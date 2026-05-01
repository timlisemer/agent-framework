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
 *   Transcript: ~/.claude/projects/<encoded-project>/abc123.jsonl
 *   Entry contains: {"slug": "woolly-swinging-neumann", ...}
 *   Plan file: ~/.claude/plans/woolly-swinging-neumann.md
 *
 * @module session-utils
 */

import * as fs from "fs";
import { claudePlanFile } from "./paths.js";

interface SessionMetadata {
  slug?: string;
}

/**
 * Extract the slug from a session JSONL file.
 * Reads the first few lines to find the slug field.
 */
async function extractSlugFromSession(transcriptPath: string): Promise<string | null> {
  try {
    const content = await fs.promises.readFile(transcriptPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

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
 * Honors AGENT_FRAMEWORK_PLAN_DIR env var first (used by scenario runner
 * to redirect plan files to a per-scenario plans/ dir), then falls back
 * to ~/.claude/plans/<slug>.md.
 * Returns null if no plan exists for this session.
 */
export async function resolvePlanPath(transcriptPath: string): Promise<string | null> {
  const slug = await extractSlugFromSession(transcriptPath);
  if (!slug) return null;

  const planPath = claudePlanFile(slug);

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
