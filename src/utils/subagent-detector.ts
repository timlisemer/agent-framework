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
 * Detection is based on transcript metadata:
 * - Regular sessions have isSidechain: false and no agentId
 * - Subagents have isSidechain: true and an agentId field
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns true if this is a subagent session
 */
export function isSubagent(transcriptPath: string): boolean {
  let fd: number | undefined;
  try {
    // Read only first 512 bytes (sufficient for metadata JSON) instead of entire file
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(512);
    fs.readSync(fd, buffer, 0, 512, 0);
    fs.closeSync(fd);
    fd = undefined;

    const firstLine = buffer.toString("utf-8").split("\n")[0];
    if (!firstLine) return false;

    const entry: TranscriptMetadata = JSON.parse(firstLine);

    // Subagents have both isSidechain: true AND an agentId
    return entry.isSidechain === true && typeof entry.agentId === "string";
  } catch {
    // Can't read transcript - assume not a subagent (fail-safe to strict mode)
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
