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

const DEBUG = process.env.AGENT_FRAMEWORK_DEBUG === "1";

interface TranscriptMetadata {
  isSidechain?: boolean;
  agentId?: string;
  type?: string;
  summary?: string;
  parentId?: string;
  cwd?: string;
  model?: string;
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
 * 3. Content-based: Look for subagent-specific patterns in first few lines
 *
 * @param transcriptPath - Path to the transcript JSONL file
 * @returns true if this is a subagent session
 */
export function isSubagent(transcriptPath: string): boolean {
  // Primary detection: filename pattern (most reliable)
  // Agent transcripts are always named "agent-*.jsonl"
  const basename = path.basename(transcriptPath);
  if (basename.startsWith("agent-") && basename.endsWith(".jsonl")) {
    if (DEBUG) {
      console.error(`[subagent-detector] DETECTED via filename: ${basename}`);
    }
    return true;
  }

  // Fallback: read transcript metadata
  let fd: number | undefined;
  try {
    // Read first 4096 bytes (increased buffer for longer first lines and multi-line check)
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
    fs.closeSync(fd);
    fd = undefined;

    const content = buffer.toString("utf-8", 0, bytesRead);
    const lines = content.split("\n").filter(Boolean);

    if (lines.length === 0) {
      if (DEBUG) {
        console.error(`[subagent-detector] NO LINES in ${basename}`);
      }
      return false;
    }

    // Check first line for standard metadata
    try {
      const entry: TranscriptMetadata = JSON.parse(lines[0]);

      // Subagents have both isSidechain: true AND an agentId
      if (entry.isSidechain === true && typeof entry.agentId === "string") {
        if (DEBUG) {
          console.error(`[subagent-detector] DETECTED via metadata: isSidechain=${entry.isSidechain} agentId=${entry.agentId}`);
        }
        return true;
      }

      if (DEBUG) {
        console.error(`[subagent-detector] Metadata check: isSidechain=${entry.isSidechain} agentId=${entry.agentId} (not subagent)`);
      }
    } catch {
      if (DEBUG) {
        console.error(`[subagent-detector] Failed to parse first line as JSON in ${basename}`);
      }
    }

    // Content-based fallback: check first few lines for subagent indicators
    // This catches edge cases where metadata is missing but content indicates subagent context
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      try {
        const entry: TranscriptMetadata = JSON.parse(lines[i]);

        // Type "summary" with agent-related content suggests subagent
        if (entry.type === "summary" && entry.summary?.toLowerCase().includes("agent")) {
          if (DEBUG) {
            console.error(`[subagent-detector] DETECTED via content: summary contains 'agent'`);
          }
          return true;
        }

        // If we see main session markers without subagent markers, definitely not a subagent
        if (entry.cwd && entry.model && entry.isSidechain === undefined) {
          if (DEBUG) {
            console.error(`[subagent-detector] MAIN SESSION detected: has cwd/model, no isSidechain`);
          }
          return false;
        }
      } catch {
        // Line isn't valid JSON, continue
      }
    }

    if (DEBUG) {
      console.error(`[subagent-detector] NOT DETECTED for ${basename} (no indicators found)`);
    }
    return false;
  } catch (error) {
    // Log error for debugging (stderr won't affect hook JSON output)
    if (DEBUG) {
      console.error(`[subagent-detector] Error reading ${transcriptPath}:`, error);
    }
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
