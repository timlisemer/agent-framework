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

import { CacheManager } from "./cache-manager.js";
import type { DecisionType } from "../telemetry/types.js";
import type { ExecutionType } from "../types.js";

/**
 * Configuration for statusline display.
 * Change displayCount to show more/fewer entries.
 */
export const STATUSLINE_CONFIG = {
  /** Number of recent decisions to display (change to 3+ for more) */
  displayCount: 2,
  /** Maximum entries to keep in state buffer */
  maxEntries: 10,
  /** State expiry in milliseconds (5 minutes) */
  expiryMs: 5 * 60 * 1000,
} as const;

/**
 * Single decision entry for statusline display.
 */
export interface StatusLineEntry {
  /** Agent that made the decision (e.g., "tool-approve", "check") */
  agent: string;
  /** Decision type (APPROVE, DENY, CONFIRM, etc.) */
  decision: DecisionType;
  /** Tool being evaluated (e.g., "Bash", "Edit") */
  toolName: string;
  /** Timestamp in milliseconds */
  timestamp: number;
  /** Execution type (llm or typescript) */
  executionType: ExecutionType;
  /** Latency in milliseconds */
  latencyMs: number;
}

/**
 * StatusLine state file structure.
 */
interface StatusLineData {
  entries: StatusLineEntry[];
}

const cacheManager = new CacheManager<StatusLineData>({
  filePath: "/tmp/claude-statusline.json",
  defaultData: () => ({ entries: [] }),
  expiryMs: STATUSLINE_CONFIG.expiryMs,
  maxEntries: STATUSLINE_CONFIG.maxEntries,
  getTimestamp: (e) => (e as StatusLineEntry).timestamp,
  getEntries: (d) => d.entries,
  setEntries: (d, e) => ({ ...d, entries: e as StatusLineEntry[] }),
});

/**
 * Update statusline state with a new decision.
 * Called by logger after each agent decision.
 *
 * @param transcriptPath - Session identifier (transcript path)
 * @param entry - Decision entry (without timestamp)
 */
export async function updateStatusLineState(
  transcriptPath: string,
  entry: Omit<StatusLineEntry, "timestamp">
): Promise<void> {
  cacheManager.setSession(transcriptPath);
  await cacheManager.update((data) => ({
    entries: [...data.entries, { ...entry, timestamp: Date.now() }],
  }));
}

/**
 * Read the N most recent decisions for statusline display.
 * Called by the statusline script.
 *
 * @param transcriptPath - Session identifier (transcript path)
 * @param count - Number of entries to return (defaults to displayCount)
 * @returns Array of recent decision entries, newest first
 */
export async function readStatusLineEntries(
  transcriptPath: string,
  count: number = STATUSLINE_CONFIG.displayCount
): Promise<StatusLineEntry[]> {
  cacheManager.setSession(transcriptPath);
  const data = await cacheManager.load();
  // Return newest N entries, reversed so newest is first
  return data.entries.slice(-count).reverse();
}
