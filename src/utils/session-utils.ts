/**
 * Session Utilities - Plan File Resolution and Summary Access
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
import {
  getSummaryPath,
  readSummary,
  readSection,
  type SummaryDocument,
} from "./summary-cache.js";

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

/**
 * Read the full session summary for a given transcript.
 * Returns null if no summary exists.
 */
export async function readSessionSummary(transcriptPath: string): Promise<SummaryDocument | null> {
  try {
    const summaryPath = await getSummaryPath(transcriptPath);
    return await readSummary(summaryPath);
  } catch {
    return null;
  }
}

/**
 * Read a single section from the session summary.
 * Returns empty string if summary or section doesn't exist.
 */
export async function readSummarySection(transcriptPath: string, section: string): Promise<string> {
  try {
    const summaryPath = await getSummaryPath(transcriptPath);
    return await readSection(summaryPath, section);
  } catch {
    return "";
  }
}
