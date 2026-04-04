/**
 * Tool Prediction Cache - Intent-based predictions with regex-powered blocking.
 *
 * Stores natural language intent descriptions (expectedIntent, blockedIntent) for
 * LLM agent context, plus a mechanical blocklist (blockedTools) with regex pattern
 * matching and exception support.
 *
 * Uses lazy CacheManager initialization (same pattern as gate-reasoning-cache.ts).
 *
 * @module prediction-cache
 */

import * as path from "path";
import { CacheManager } from "./cache-manager.js";

export interface BlockedTool {
  /** Regex pattern matched against tool name (e.g. ".*", "Bash", "Edit|Write") */
  toolName: string;
  /** Optional glob pattern for command/file_path matching */
  targetPattern?: string;
  reason: string;
  /** Tool names exempt from this rule (exact match) */
  exceptions?: string[];
}

export interface AllowedTool {
  toolName: string;
  targetPattern?: string;
  reason: string;
}

export interface ToolPrediction {
  /** Natural language description of what tools/actions are expected */
  expectedIntent: string;
  /** Natural language description of what tools/actions are NOT wanted */
  blockedIntent: string;
  /** Concrete tool entries that are mechanically blocked (regex + exceptions) */
  blockedTools: BlockedTool[];
  /** Tools explicitly allowed by prediction (micro or LLM) */
  allowedTools?: AllowedTool[];
  /** Origin of this prediction */
  source?: "micro" | "llm" | "gate";
  /** Hash of the user message that generated this prediction */
  userMessageHash?: string;
  userMessageSnippet: string;
  timestamp: number;
  /** Whether this prediction is still active */
  active: boolean;
  /** Whether this prediction explicitly blocks the AI from stopping (default: false/undefined = stopping OK) */
  blockStop?: boolean;
}

/**
 * Check if any active prediction explicitly blocks stopping.
 */
export function isStopBlocked(predictions: ToolPrediction[]): boolean {
  return predictions.some((p) => p.blockStop === true);
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
    maxEntries: 20,
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
 * Get the most recent active (non-expired) prediction, or null if none exists.
 */
export async function getActivePrediction(sessionDir: string): Promise<ToolPrediction | null> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  const activeEntries = data.entries.filter((e) => e.active === true);
  return activeEntries.length > 0 ? activeEntries[activeEntries.length - 1] : null;
}

/**
 * Get all active (non-expired) predictions.
 */
export async function getAllPredictions(sessionDir: string): Promise<ToolPrediction[]> {
  const manager = getManager(sessionDir);
  const data = await manager.load();
  return data.entries.filter((e) => e.active === true);
}

/**
 * Save a new prediction (appends to existing entries).
 */
export async function savePrediction(sessionDir: string, prediction: ToolPrediction): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update((data) => ({
    ...data,
    entries: [...data.entries, { ...prediction, active: true }],
  }));
}

/**
 * Deactivate the prediction entry whose blockedTools matched the given tool.
 * Used when an appeal overturns a prediction block — only that specific entry is deactivated.
 */
export async function deactivatePrediction(
  sessionDir: string,
  toolName: string,
  toolInput: unknown
): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update((data) => ({
    ...data,
    entries: data.entries.map((entry) => {
      if (!entry.active) return entry;
      const match = matchBlockedTool(toolName, toolInput, entry.blockedTools);
      return match ? { ...entry, active: false } : entry;
    }),
  }));
}

/**
 * Deactivate all active predictions.
 * Used on plan-to-implementation transitions (ExitPlanMode).
 */
export async function deactivateAllPredictions(sessionDir: string): Promise<void> {
  const manager = getManager(sessionDir);
  await manager.update((data) => ({
    ...data,
    entries: data.entries.map((entry) =>
      entry.active ? { ...entry, active: false } : entry
    ),
  }));
}

/**
 * Format prediction context for LLM agent consumption.
 */
export function formatPredictionContext(prediction: ToolPrediction): string {
  const parts: string[] = [];
  if (prediction.expectedIntent) {
    parts.push(`Expected intent: ${prediction.expectedIntent}`);
  }
  if (prediction.blockedIntent) {
    parts.push(`Blocked intent: ${prediction.blockedIntent}`);
  }
  if (prediction.blockedTools.length > 0) {
    const blocked = prediction.blockedTools.map((b) => {
      let desc = b.toolName;
      if (b.exceptions?.length) desc += ` (except ${b.exceptions.join(", ")})`;
      return desc;
    });
    parts.push(`Mechanically blocked: ${blocked.join("; ")}`);
  }
  return parts.join("\n");
}

/**
 * Check if a tool call matches any blocked tool entry.
 * Supports regex patterns in toolName and exception lists.
 * Returns the matching BlockedTool, or null if no match.
 */
export function matchBlockedTool(
  toolName: string,
  toolInput: unknown,
  blockedTools: BlockedTool[]
): BlockedTool | null {
  for (const blocked of blockedTools) {
    // Check exceptions first — if tool is exempt, skip this rule
    if (blocked.exceptions?.includes(toolName)) continue;

    // Match toolName as regex pattern
    if (!toolNameMatches(toolName, blocked.toolName)) continue;

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
 * Match a tool name against a pattern.
 * If pattern contains regex metacharacters, treat as regex. Otherwise exact match.
 */
function toolNameMatches(toolName: string, pattern: string): boolean {
  if (/[.*|[\]()^$+?\\]/.test(pattern)) {
    try {
      const regex = new RegExp(`^(?:${pattern})$`);
      return regex.test(toolName);
    } catch {
      return toolName === pattern;
    }
  }
  return toolName === pattern;
}

/**
 * Simple glob matching for target patterns.
 * Supports * as wildcard at the end (e.g., "git *" matches "git push")
 * and * at the start (e.g., "*file.ts" matches "/path/to/file.ts").
 */
function globMatch(value: string, pattern: string): boolean {
  if (pattern.startsWith("*") && pattern.endsWith("*")) {
    return value.includes(pattern.slice(1, -1));
  }
  if (pattern.endsWith("*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  if (pattern.startsWith("*")) {
    return value.endsWith(pattern.slice(1));
  }
  return value === pattern;
}

/**
 * Check if a tool call matches any allowed tool entry.
 * Returns the matching AllowedTool, or null if no match.
 */
export function matchAllowedTool(
  toolName: string,
  toolInput: unknown,
  allowedTools: AllowedTool[]
): AllowedTool | null {
  for (const allowed of allowedTools) {
    if (!toolNameMatches(toolName, allowed.toolName)) continue;

    if (!allowed.targetPattern) return allowed;

    const input = toolInput as Record<string, unknown>;
    const command = (input?.command as string) ?? "";
    const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
    const target = command || filePath;

    if (target && globMatch(target, allowed.targetPattern)) {
      return allowed;
    }
  }
  return null;
}

/**
 * Check ALL active predictions for a blocked tool match.
 * Prioritizes source "llm" over "micro". Returns the first match.
 */
export function matchBlockedToolFromAll(
  toolName: string,
  toolInput: unknown,
  predictions: ToolPrediction[]
): { prediction: ToolPrediction; blocked: BlockedTool } | null {
  // Sort: LLM predictions first, then micro
  const sorted = [...predictions].sort((a, b) => {
    const aScore = a.source === "llm" ? 0 : a.source === "gate" ? 1 : 2;
    const bScore = b.source === "llm" ? 0 : b.source === "gate" ? 1 : 2;
    return aScore - bScore;
  });

  for (const prediction of sorted) {
    const blocked = matchBlockedTool(toolName, toolInput, prediction.blockedTools);
    if (blocked) {
      return { prediction, blocked };
    }
  }
  return null;
}
