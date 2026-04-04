/**
 * Correction Cache - Multi-entry correction cache replacing pending-validation-cache.
 *
 * Stores corrections from PostToolUse and summary-updater actions mode.
 * Read by PreToolUse (step 3) and StopHook for live interruption.
 *
 * @module correction-cache
 */

import * as path from "path";
import { CacheManager } from "./cache-manager.js";

const CORRECTION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

export interface CorrectionEntry {
  toolName: string;
  toolTarget: string;
  reason: string;
  source: "post-tool" | "summary-actions";
  timestamp: number;
  consumed: boolean;
}

interface CorrectionData {
  entries: CorrectionEntry[];
}

let cacheManager: CacheManager<CorrectionData> | null = null;

/**
 * Initialize the correction cache for a session directory.
 */
export function initCorrectionSession(sessionDir: string): void {
  cacheManager = new CacheManager<CorrectionData>({
    filePath: path.join(sessionDir, "correction-cache.json"),
    defaultData: () => ({ entries: [] }),
    expiryMs: CORRECTION_EXPIRY_MS,
    maxEntries: 20,
    getTimestamp: (e) => (e as CorrectionEntry).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as CorrectionEntry[] }),
  });
}

function getManager(sessionDir: string): CacheManager<CorrectionData> {
  if (!cacheManager) {
    initCorrectionSession(sessionDir);
  }
  return cacheManager!;
}

/**
 * Write a correction entry to the cache.
 */
export async function writeCorrection(sessionDir: string, entry: CorrectionEntry): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update((data) => ({
    ...data,
    entries: [...data.entries, entry],
  }));
}

/**
 * Get all unconsumed corrections (within expiry window).
 */
export async function getUnconsumedCorrections(sessionDir: string): Promise<CorrectionEntry[]> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  const now = Date.now();
  return data.entries.filter(
    (e) => !e.consumed && (now - e.timestamp) < CORRECTION_EXPIRY_MS
  );
}

/**
 * Mark all corrections as consumed.
 */
export async function consumeCorrections(sessionDir: string): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update((data) => ({
    ...data,
    entries: data.entries.map((e) => ({ ...e, consumed: true })),
  }));
}

/**
 * Clear all corrections. Called on new user message to remove stale corrections.
 */
export async function clearCorrections(sessionDir: string): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update(() => ({ entries: [] }));
}
