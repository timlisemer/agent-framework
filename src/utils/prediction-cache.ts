/**
 * Tool Prediction Cache - Expected and blocked tool lists derived from user intent.
 *
 * Predictions handle non-file-edit tools only (Bash commands, MCP tools, etc.).
 * File-modification blocking is handled exclusively by edit intent flags.
 *
 * Uses lazy CacheManager initialization (same pattern as gate-reasoning-cache.ts).
 *
 * @module prediction-cache
 */

import * as path from "path";
import { CacheManager } from "./cache-manager.js";

export interface BlockedTool {
  toolName: string;
  targetPattern?: string;
  reason: string;
}

export interface ToolPrediction {
  expectedTools: string[];
  blockedTools: BlockedTool[];
  userMessageSnippet: string;
  timestamp: number;
}

interface PredictionData {
  entries: ToolPrediction[];
}

let cacheManager: CacheManager<PredictionData> | null = null;

/**
 * Initialize the prediction cache for a session directory.
 * Resets the singleton CacheManager to point at the given directory.
 */
export function initPredictionSession(sessionDir: string): void {
  cacheManager = new CacheManager<PredictionData>({
    filePath: path.join(sessionDir, "prediction-cache.json"),
    defaultData: () => ({ entries: [] }),
    expiryMs: 10 * 60 * 1000,
    maxEntries: 1,
    getTimestamp: (e) => (e as ToolPrediction).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as ToolPrediction[] }),
  });
}

function getManager(sessionDir: string): CacheManager<PredictionData> {
  if (!cacheManager) {
    initPredictionSession(sessionDir);
  }
  return cacheManager!;
}

/**
 * Get the active (non-expired) prediction, or null if none exists.
 */
export async function getActivePrediction(sessionDir: string): Promise<ToolPrediction | null> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  return data.entries.length > 0 ? data.entries[0] : null;
}

/**
 * Save a new prediction (replaces any existing one).
 */
export async function savePrediction(sessionDir: string, prediction: ToolPrediction): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.save({ entries: [prediction] });
}

/**
 * Clear all predictions.
 */
export async function clearPredictions(sessionDir: string): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.clear();
}

/**
 * Check if a tool call matches any blocked tool entry.
 * Returns the matching BlockedTool, or null if no match.
 */
export function matchBlockedTool(
  toolName: string,
  toolInput: unknown,
  blockedTools: BlockedTool[]
): BlockedTool | null {
  for (const blocked of blockedTools) {
    if (blocked.toolName !== toolName) continue;

    // If no targetPattern, matches all invocations of this tool
    if (!blocked.targetPattern) return blocked;

    // Check targetPattern against command (for Bash) or other input
    const input = toolInput as Record<string, unknown>;
    const command = (input?.command as string) ?? "";
    const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
    const target = command || filePath;

    if (target && globMatch(target, blocked.targetPattern)) {
      return blocked;
    }
  }
  return null;
}

/**
 * Simple glob matching for target patterns.
 * Supports * as wildcard at the end (e.g., "git *" matches "git push").
 */
function globMatch(value: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}
