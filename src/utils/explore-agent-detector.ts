/**
 * Explore Agent Detector
 *
 * Detects if the current session is running as a subagent (spawned via Task tool).
 * Subagents (including Explore agents) have different transcript metadata:
 * - isSidechain: true
 * - agentId: string (e.g., "a792db3")
 *
 * This detection is used to enforce lazy validation for subagents even when
 * the parent session is in plan mode, since subagents are typically read-only
 * investigation agents that don't need strict validation.
 *
 * @module explore-agent-detector
 */

import * as fs from "fs";

interface TranscriptMetadata {
  isSidechain?: boolean;
  agentId?: string;
}

/**
 * Check if the current session is a subagent (Explore or other Task-spawned agent).
 *
 * Detection is based on transcript metadata:
 * - Regular sessions have isSidechain: false and no agentId
 * - Subagents have isSidechain: true and an agentId field
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns true if this is a subagent session
 */
export function isSubagent(transcriptPath: string): boolean {
  try {
    const content = fs.readFileSync(transcriptPath, "utf-8");
    // Parse only the first line (metadata)
    const firstLine = content.split("\n")[0];
    if (!firstLine) return false;

    const entry: TranscriptMetadata = JSON.parse(firstLine);

    // Subagents have both isSidechain: true AND an agentId
    return entry.isSidechain === true && typeof entry.agentId === "string";
  } catch {
    // Can't read transcript - assume not a subagent (fail-safe to strict mode)
    return false;
  }
}

/**
 * Alias for clarity in pre-tool-use hook.
 * Explore agents are a type of subagent with read-only access.
 * We treat all subagents as "explore-like" for lazy validation purposes.
 */
export const isExploreAgent = isSubagent;
