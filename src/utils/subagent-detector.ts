/**
 * Subagent Detector
 *
 * Detects if the current session is running as a subagent (spawned via Task tool).
 * Subagents have different transcript metadata:
 * - isSidechain: true
 * - agentId: string (e.g., "a792db3")
 *
 * All subagents get lazy validation - they are typically read-only exploration
 * agents that don't need strict validation even when the parent is in plan mode.
 *
 * @module subagent-detector
 */

import * as fs from "fs";
import * as path from "path";

interface TranscriptMetadata {
  isSidechain?: boolean;
  agentId?: string;
}

/**
 * Check if the current session is a subagent (spawned via Task tool).
 *
 * All subagents get lazy validation - they are typically read-only exploration
 * agents that don't need strict validation even when the parent is in plan mode.
 *
 * Detection methods (in order):
 * 1. Filename pattern: agent-*.jsonl (most reliable, no file I/O)
 * 2. Transcript metadata: isSidechain: true AND agentId field
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns true if this is a subagent session
 */
export function isSubagent(transcriptPath: string): boolean {
  // Primary detection: filename pattern (most reliable)
  // Agent transcripts are always named "agent-*.jsonl"
  const basename = path.basename(transcriptPath);
  if (basename.startsWith("agent-") && basename.endsWith(".jsonl")) {
    return true;
  }

  // Fallback: read transcript metadata
  let fd: number | undefined;
  try {
    // Read first 2048 bytes (increased buffer for longer first lines)
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(2048);
    fs.readSync(fd, buffer, 0, 2048, 0);
    fs.closeSync(fd);
    fd = undefined;

    const firstLine = buffer.toString("utf-8").split("\n")[0];
    if (!firstLine) return false;

    const entry: TranscriptMetadata = JSON.parse(firstLine);

    // Subagents have both isSidechain: true AND an agentId
    return entry.isSidechain === true && typeof entry.agentId === "string";
  } catch (error) {
    // Log error for debugging (stderr won't affect hook JSON output)
    console.error(`[subagent-detector] Error reading ${transcriptPath}:`, error);
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
    return false;
  }
}
