/**
 * StatusLine State - Session-aware state for Claude Code statusLine display
 *
 * Maintains a circular buffer of recent agent decisions that can be
 * displayed in Claude Code's statusLine feature.
 *
 * Uses CacheManager for session isolation - each Claude Code session
 * sees only its own decisions.
 *
 * @module statusline-state
 */

import * as path from "path";
import { execSync } from "child_process";
import { CacheManager, getTempFilePath } from "./cache-manager.js";
import type { DecisionType } from "../telemetry/types.js";
import type { ExecutionType } from "../types.js";

/**
 * Configuration for statusline display.
 */
export const STATUSLINE_CONFIG = {
  /** Maximum entries to keep in state buffer */
  maxEntries: 50,
  /** State expiry in milliseconds (5 minutes) */
  expiryMs: 5 * 60 * 1000,
} as const;

/** How long completed entries stay before being deleted (5 seconds) */
const COMPLETED_EXPIRY_MS = 5000;

/**
 * Schedule cleanup of a completed entry after the fade-out period.
 * Spawns a non-blocking background task that removes the entry after 5 seconds.
 * Uses .unref() to prevent the timer from keeping the process alive.
 */
function scheduleEntryCleanup(
  transcriptPath: string,
  agent: string,
  toolName: string
): void {
  setTimeout(async () => {
    try {
      cacheManager.setSession(getSessionKey(transcriptPath));
      await cacheManager.update((data) => ({
        entries: data.entries.filter(
          (e) =>
            !(
              e.agent === agent &&
              e.toolName === toolName &&
              e.status === "completed"
            )
        ),
      }));
    } catch {
      // Ignore cleanup errors - best effort
    }
  }, COMPLETED_EXPIRY_MS).unref();
}

/**
 * Cached process session ID (SID) to avoid repeated shell calls.
 * The SID is inherited by all child processes, so subagents share
 * the same SID as their parent Claude Code session.
 */
let cachedSid: string | undefined;

/**
 * Get the Unix process session ID (SID) for the current process.
 * The SID is inherited by all child processes, making it ideal for
 * grouping parent sessions with their subagents while isolating
 * parallel Claude Code instances.
 */
function getProcessSessionId(): string {
  if (cachedSid) return cachedSid;
  try {
    cachedSid = execSync(`ps -o sid= -p ${process.pid}`, {
      encoding: "utf8",
    }).trim();
    return cachedSid;
  } catch {
    // Fallback to PID if ps fails (shouldn't happen on Unix)
    return String(process.pid);
  }
}

/**
 * Get session key from transcript path and process session ID.
 * Combines the project directory with the Unix SID to:
 * 1. Isolate parallel Claude Code sessions (different SIDs)
 * 2. Share statusLine between parent and subagents (same SID)
 * 3. Automatically invalidate when Claude Code exits (SID no longer exists)
 */
function getSessionKey(transcriptPath: string): string {
  const projectDir = path.dirname(transcriptPath);
  const sid = getProcessSessionId();
  return `${projectDir}:${sid}`;
}

/**
 * Filter out completed entries older than COMPLETED_EXPIRY_MS.
 * Running entries are always preserved.
 */
function filterExpiredCompleted(entries: StatusLineEntry[]): StatusLineEntry[] {
  const now = Date.now();
  return entries.filter((entry) => {
    if (entry.status === "running") return true;
    return now - entry.timestamp < COMPLETED_EXPIRY_MS;
  });
}

/**
 * Single decision entry for statusline display.
 */
export interface StatusLineEntry {
  /** Agent that made the decision (e.g., "tool-approve", "check") */
  agent: string;
  /** Decision type (APPROVE, DENY, CONFIRM, etc.) - undefined when running */
  decision?: DecisionType;
  /** Tool being evaluated (e.g., "Bash", "Edit") */
  toolName: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** When the agent started running */
  startTime: number;
  /** Execution type (llm or typescript) - undefined when running */
  executionType?: ExecutionType;
  /** Latency in milliseconds - undefined when running */
  latencyMs?: number;
  /** Status of the agent: running or completed */
  status: "running" | "completed";
}

/**
 * StatusLine state file structure.
 */
interface StatusLineData {
  entries: StatusLineEntry[];
}

const cacheManager = new CacheManager<StatusLineData>({
  filePath: getTempFilePath("statusline.json"),
  defaultData: () => ({ entries: [] }),
  expiryMs: STATUSLINE_CONFIG.expiryMs,
  maxEntries: STATUSLINE_CONFIG.maxEntries,
  getTimestamp: (e) => (e as StatusLineEntry).timestamp,
  getEntries: (d) => d.entries,
  setEntries: (d, e) => ({ ...d, entries: e as StatusLineEntry[] }),
});

/**
 * Set of pending statusline update promises.
 * Used by flushStatuslineUpdates to ensure all writes complete before process exit.
 */
const pendingUpdates: Set<Promise<void>> = new Set();

/**
 * Track a promise and remove it from the set when it completes.
 * Called by logger.ts to track statusline update promises.
 */
export function trackStatuslinePromise(promise: Promise<void>): void {
  pendingUpdates.add(promise);
  promise.finally(() => pendingUpdates.delete(promise));
}

/**
 * Flush all pending statusline updates.
 * Call this before process.exit() to ensure all statusline writes complete.
 *
 * @returns Promise that resolves when all pending updates are settled
 */
export async function flushStatuslineUpdates(): Promise<void> {
  await Promise.allSettled([...pendingUpdates]);
}

/**
 * Mark an agent as started (running).
 * Called before agent execution begins.
 *
 * @param transcriptPath - Session identifier (transcript path)
 * @param entry - Agent info (agent name and tool name)
 */
export async function markAgentStarted(
  transcriptPath: string,
  entry: { agent: string; toolName: string }
): Promise<void> {
  cacheManager.setSession(getSessionKey(transcriptPath));
  const now = Date.now();
  await cacheManager.update((data) => ({
    entries: [
      ...filterExpiredCompleted(data.entries),
      {
        agent: entry.agent,
        toolName: entry.toolName,
        timestamp: now,
        startTime: now,
        status: "running" as const,
      },
    ],
  }));
}

/**
 * Update statusline state with a completed decision.
 * Called by logger after each agent decision.
 * This will find and update any running entry for the same agent/tool,
 * or add a new completed entry if none found.
 *
 * @param transcriptPath - Session identifier (transcript path)
 * @param entry - Decision entry (without timestamp and startTime)
 */
export async function updateStatusLineState(
  transcriptPath: string,
  entry: Omit<StatusLineEntry, "timestamp" | "startTime" | "status">
): Promise<void> {
  cacheManager.setSession(getSessionKey(transcriptPath));
  const now = Date.now();
  await cacheManager.update((data) => {
    // Filter out expired completed entries first
    const entries = filterExpiredCompleted(data.entries);

    // Find the most recent running entry for this agent/tool (search from end)
    let runningIndex = -1;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.agent === entry.agent && e.toolName === entry.toolName && e.status === "running") {
        runningIndex = i;
        break;
      }
    }

    if (runningIndex !== -1) {
      // Update the running entry to completed
      const runningEntry = entries[runningIndex];
      const updatedEntries = [...entries];
      updatedEntries[runningIndex] = {
        ...entry,
        timestamp: now,
        startTime: runningEntry.startTime,
        status: "completed" as const,
      };
      return { entries: updatedEntries };
    }

    // No running entry found, add as new completed entry
    return {
      entries: [
        ...entries,
        {
          ...entry,
          timestamp: now,
          startTime: now,
          status: "completed" as const,
        },
      ],
    };
  });

  // Schedule cleanup after fade-out period
  scheduleEntryCleanup(transcriptPath, entry.agent, entry.toolName);
}

/**
 * Read all decisions for statusline display.
 * Called by the statusline script.
 *
 * @param transcriptPath - Session identifier (transcript path)
 * @returns Array of decision entries, newest first
 */
export async function readStatusLineEntries(
  transcriptPath: string
): Promise<StatusLineEntry[]> {
  cacheManager.setSession(getSessionKey(transcriptPath));
  const data = await cacheManager.load();
  // Filter expired completed entries and return reversed (newest first)
  return filterExpiredCompleted(data.entries).reverse();
}
