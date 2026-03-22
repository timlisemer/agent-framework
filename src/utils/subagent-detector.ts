/**
 * Subagent Detector
 *
 * Consolidated subagent detection with active-counter fallback.
 * Detects if the current session is running as a subagent (spawned via Task tool)
 * OR if the tool call is likely from a subagent that leaked through with the
 * parent's transcript_path (race condition in Claude Code).
 *
 * Detection methods (in order):
 * 1. Filename pattern: agent-*.jsonl (most reliable, no file I/O)
 * 2. Path segment: /subagents/ directory in transcript path
 * 3. Transcript metadata: isSidechain: true AND agentId field
 * 4. Content-based: Look for subagent-specific patterns in first few lines
 * 5. Counter fallback: active subagent counter > 0 (catches race condition)
 *
 * All subagents get lazy validation - they are typically read-only exploration
 * agents that don't need strict validation even when the parent is in plan mode.
 *
 * @module subagent-detector
 */

import * as fs from "fs";
import * as path from "path";
import { getSessionDir } from "./cache-manager.js";

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

export interface SubagentDetectionResult {
  isSubagent: boolean;
  method: "filename" | "path-segment" | "metadata" | "content" | "counter-fallback" | "none";
  activeSubagentCount: number;
}

// ── Active subagent counter ──────────────────────────────────────────
// SubagentStart/SubagentStop hooks maintain a counter so the detector
// and PostToolUse can adapt behavior during subagent execution.
// Staleness protection: if the counter file is older than 10 minutes,
// return 0 (assumes subagent crashed without firing SubagentStop).

const SUBAGENT_COUNTER_FILE = "active-subagents.json";
const SUBAGENT_STALE_MS = 10 * 60 * 1000;

let counterCache: { sessionDir: string; count: number; ts: number } | null = null;
const COUNTER_CACHE_TTL_MS = 2000;

function getCachedSubagentCount(sessionDir: string): number {
  if (counterCache && counterCache.sessionDir === sessionDir && Date.now() - counterCache.ts < COUNTER_CACHE_TTL_MS) {
    return counterCache.count;
  }
  const count = getActiveSubagentCount(sessionDir);
  counterCache = { sessionDir, count, ts: Date.now() };
  return count;
}

const SUBAGENT_LOCK_STALE_MS = 1000;

function acquireSubagentLock(lockPath: string): void {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === "EEXIST") {
        try {
          const stat = fs.statSync(lockPath);
          if (Date.now() - stat.mtimeMs > SUBAGENT_LOCK_STALE_MS) {
            try { fs.unlinkSync(lockPath); } catch {}
            continue;
          }
        } catch { continue; }
        const start = Date.now();
        while (Date.now() - start < 10) { /* spin */ }
        continue;
      }
      return;
    }
  }
}

function releaseSubagentLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch {}
}

function readSubagentCount(filePath: string): number {
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > SUBAGENT_STALE_MS) {
      return 0;
    }
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return typeof data.count === "number" ? data.count : 0;
  } catch {
    return 0;
  }
}

export function getActiveSubagentCount(sessionDir: string): number {
  const filePath = path.join(sessionDir, SUBAGENT_COUNTER_FILE);
  return readSubagentCount(filePath);
}

export function incrementActiveSubagents(sessionDir: string): void {
  const filePath = path.join(sessionDir, SUBAGENT_COUNTER_FILE);
  const lockPath = filePath + ".lock";
  acquireSubagentLock(lockPath);
  try {
    const current = readSubagentCount(filePath);
    fs.writeFileSync(filePath, JSON.stringify({ count: current + 1 }));
  } finally {
    releaseSubagentLock(lockPath);
  }
}

export function decrementActiveSubagents(sessionDir: string): void {
  const filePath = path.join(sessionDir, SUBAGENT_COUNTER_FILE);
  const lockPath = filePath + ".lock";
  acquireSubagentLock(lockPath);
  try {
    const current = readSubagentCount(filePath);
    fs.writeFileSync(filePath, JSON.stringify({ count: Math.max(0, current - 1) }));
  } finally {
    releaseSubagentLock(lockPath);
  }
}

// ── Detection ────────────────────────────────────────────────────────

/**
 * Full subagent detection with method and counter info.
 *
 * Use this when you need to know HOW the subagent was detected
 * (e.g. to distinguish counter-fallback from filename match).
 */
export function detectSubagent(transcriptPath: string): SubagentDetectionResult {
  const basename = path.basename(transcriptPath);

  // 1. Filename pattern (no I/O)
  if (basename.startsWith("agent-") && basename.endsWith(".jsonl")) {
    if (DEBUG) {
      console.error(`[subagent-detector] DETECTED via filename: ${basename}`);
    }
    return { isSubagent: true, method: "filename", activeSubagentCount: 0 };
  }

  // 2. Path segment (no I/O)
  if (transcriptPath.includes("/subagents/") || transcriptPath.includes("\\subagents\\")) {
    if (DEBUG) {
      console.error(`[subagent-detector] DETECTED via path segment: /subagents/ in ${basename}`);
    }
    return { isSubagent: true, method: "path-segment", activeSubagentCount: 0 };
  }

  // 3-4. Metadata and content-based detection (reads first 4096 bytes)
  let fd: number | undefined;
  try {
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
      return checkCounterFallback(transcriptPath, basename);
    }

    // 3. Check first line for standard metadata
    try {
      const entry: TranscriptMetadata = JSON.parse(lines[0]);

      if (entry.isSidechain === true && typeof entry.agentId === "string") {
        if (DEBUG) {
          console.error(`[subagent-detector] DETECTED via metadata: isSidechain=${entry.isSidechain} agentId=${entry.agentId}`);
        }
        return { isSubagent: true, method: "metadata", activeSubagentCount: 0 };
      }

      if (DEBUG) {
        console.error(`[subagent-detector] Metadata check: isSidechain=${entry.isSidechain} agentId=${entry.agentId} (not subagent)`);
      }
    } catch {
      if (DEBUG) {
        console.error(`[subagent-detector] Failed to parse first line as JSON in ${basename}`);
      }
    }

    // 4. Content-based fallback: check first few lines for subagent indicators
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      try {
        const entry: TranscriptMetadata = JSON.parse(lines[i]);

        if (entry.type === "summary" && entry.summary?.toLowerCase().includes("agent")) {
          if (DEBUG) {
            console.error(`[subagent-detector] DETECTED via content: summary contains 'agent'`);
          }
          return { isSubagent: true, method: "content", activeSubagentCount: 0 };
        }

        // Main session markers without subagent markers — fall through to counter
        if (entry.cwd && entry.model && entry.isSidechain === undefined) {
          if (DEBUG) {
            console.error(`[subagent-detector] MAIN SESSION detected: has cwd/model, no isSidechain`);
          }
          return checkCounterFallback(transcriptPath, basename);
        }
      } catch {
        // Line isn't valid JSON, continue
      }
    }

    return checkCounterFallback(transcriptPath, basename);
  } catch (error) {
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
    return checkCounterFallback(transcriptPath, basename);
  }
}

/**
 * Counter fallback — catches the race condition where subagent tool calls
 * arrive with the parent's transcript_path before the subagent gets its own.
 * The subagent-start hook fires before the first tool call, so the counter
 * is already incremented by the time we check.
 */
function checkCounterFallback(transcriptPath: string, basename: string): SubagentDetectionResult {
  try {
    const sessionDir = getSessionDir(transcriptPath);
    const count = getCachedSubagentCount(sessionDir);
    if (count > 0) {
      if (DEBUG) {
        console.error(`[subagent-detector] DETECTED via counter-fallback: ${count} active subagents for ${basename}`);
      }
      return { isSubagent: true, method: "counter-fallback", activeSubagentCount: count };
    }
  } catch {
    // getSessionDir or counter read failed — not fatal
  }
  if (DEBUG) {
    console.error(`[subagent-detector] NOT DETECTED for ${basename} (no indicators found)`);
  }
  return { isSubagent: false, method: "none", activeSubagentCount: 0 };
}

/**
 * Check if the current session should be treated as a subagent.
 * Thin wrapper over detectSubagent() for backward compatibility.
 */
export function isSubagent(transcriptPath: string): boolean {
  return detectSubagent(transcriptPath).isSubagent;
}
