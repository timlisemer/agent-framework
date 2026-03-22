/**
 * StatusLine State - Session-aware state for Claude Code statusLine display
 *
 * Maintains a circular buffer of recent agent decisions that can be
 * displayed in Claude Code's statusLine feature.
 *
 * Session isolation is structural: each session has its own file in
 * the session directory. Subagents share the parent's session directory
 * (they receive the parent's transcript_path).
 *
 * @module statusline-state
 */

import * as path from "path";
import { CacheManager } from "./cache-manager.js";
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

let cacheManager: CacheManager<StatusLineData> | null = null;

/**
 * Initialize the statusline cache for a session directory.
 * Call once per hook invocation after computing sessionDir.
 */
export function initStatuslineSession(sessionDir: string): void {
  cacheManager = new CacheManager<StatusLineData>({
    filePath: path.join(sessionDir, "statusline.json"),
    defaultData: () => ({ entries: [] }),
    expiryMs: STATUSLINE_CONFIG.expiryMs,
    maxEntries: STATUSLINE_CONFIG.maxEntries,
    getTimestamp: (e) => (e as StatusLineEntry).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as StatusLineEntry[] }),
  });
}

function getManager(): CacheManager<StatusLineData> {
  if (!cacheManager) {
    throw new Error("statusline-state: initStatuslineSession() must be called before use");
  }
  return cacheManager;
}

/**
 * Set of pending statusline update promises.
 * Used by flushStatuslineUpdates to ensure all writes complete before process exit.
 * Limited to maxEntries to prevent unbounded growth if promises hang.
 */
const pendingUpdates: Set<Promise<void>> = new Set();

/**
 * Track a promise and remove it from the set when it completes.
 * Called by logger.ts to track statusline update promises.
 * Drops new promises if at capacity to prevent memory issues.
 */
export function trackStatuslinePromise(promise: Promise<void>): void {
  // Limit to maxEntries (50) to prevent unbounded growth
  if (pendingUpdates.size >= STATUSLINE_CONFIG.maxEntries) {
    return;
  }
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
 * @param entry - Agent info (agent name and tool name)
 */
export async function markAgentStarted(
  entry: { agent: string; toolName: string }
): Promise<void> {
  const now = Date.now();
  await getManager().update((data) => ({
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
 * @param entry - Decision entry (without timestamp and startTime)
 */
export async function updateStatusLineState(
  entry: Omit<StatusLineEntry, "timestamp" | "startTime" | "status">
): Promise<void> {
  const now = Date.now();
  await getManager().update((data) => {
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
}

/**
 * Read all decisions for statusline display.
 * Called by the statusline script.
 *
 * @returns Array of decision entries, newest first
 */
export async function readStatusLineEntries(): Promise<StatusLineEntry[]> {
  const data = await getManager().load();
  const filtered = filterExpiredCompleted(data.entries);

  // Persist cleanup so next poll sees clean state (fixes stale entries
  // lingering because scheduleEntryCleanup setTimeout never fires in short-lived hook processes)
  if (filtered.length < data.entries.length) {
    await getManager().update(() => ({ entries: filtered }));
  }

  return filtered.reverse();
}
