/**
 * Session state store + JSONL tool log.
 *
 * Manages per-session state via CacheManager and append-only tool logs
 * in JSONL format. All files live in the unified session directory under
 * ~/.agent-framework/.
 *
 * @module session-store
 */

import * as fs from "fs";
import * as path from "path";
import {
  CacheManager,
  getSessionDir as getSessionDirFromCacheManager,
} from "./cache-manager.js";
import type { ToolPrediction } from "./prediction-types.js";

export interface ToolLogEntry {
  ts: number;
  tool: string;
  toolUseId?: string;
  batchPosition?: number;
  batchSize?: number;
  path?: string;
  cmd?: string;
  status: string;
  gate: string;
  reason?: string;
  ms: number;
}

/**
 * Per-target state for graduated drift-block repetition detection.
 * level 0 = normal, 1 = post-Warning, 2 = post-Final-Warning, 3 = hard-errored.
 * allowedSinceLevelChange counts allowed edits since the last level-up; the
 * drift-detect rule uses it to enforce the "3 free then Final Warning" and
 * "1 free then Error" bypass windows.
 */
export interface DriftTargetState {
  level: 0 | 1 | 2 | 3;
  allowedSinceLevelChange: number;
}

export interface SessionState {
  toolCallCount: number;
  currentEditIntent: boolean | null;
  previousEditIntent: boolean | null;
  editIntentTimestamp: number;
  editIntentOverturnCount: number;
  respondFirstChecked?: boolean;
  /**
   * Single sentiment-aware prediction overwritten each UserPromptSubmit by the
   * SENTIMENT_AGENT. Read by prediction-block, gate, and stop-response-check.
   */
  currentPrediction: ToolPrediction | null;
  /**
   * Set true by tool-approve.onDenialConfirmed when a workaround Bash command is
   * denied. Cleared when mcp__agent-framework__check (or any commit/push/confirm)
   * is allowed. While true, the force-check-required rule denies all tools
   * except check / ToolSearch.
   */
  forceCheckPending: boolean;
  /**
   * Consecutive UserPromptSubmit turns where prediction.mood was angry/frustrated.
   * Reset to 0 on neutral/satisfied/happy. Capped at 5. Used by decidePrediction
   * to harden policy and surfaced to SENTIMENT_AGENT prompt.
   */
  frustrationStreak: number;
  /**
   * Window size for NEXT UserPromptSubmit's SENTIMENT_AGENT call. Bounded [2, 15].
   * Computed TS-side by `decideNextWindowSize` from previous mood/streak/context-switch.
   */
  currentWindowSize: number;
  /**
   * Per-target drift-block escalation state, keyed by absolute file path.
   * Written by drift-detect rule on allow-path increments and level-ups.
   */
  driftState: Record<string, DriftTargetState>;
  /**
   * tool_use_id of the most recently processed plan-approval tool_result.
   * Set when the PreToolUse plan-approval detector synthesizes a fresh
   * prediction; reset to null on UserPromptSubmit (since the next user
   * turn supersedes any prior approval). Prevents the detector from
   * re-firing on every subsequent PreToolUse during the same approval.
   */
  lastProcessedPlanApprovalToolUseId: string | null;
}

/**
 * Default SessionState shape. Exported so test-harness code can seed
 * state.json without applying a parallel default list (CacheManager.load only
 * uses defaults when the file is missing/corrupt; explicit seeds need every
 * field present).
 */
export function sessionStateDefaults(): SessionState {
  return {
    toolCallCount: 0,
    currentEditIntent: null,
    previousEditIntent: null,
    editIntentTimestamp: 0,
    editIntentOverturnCount: 0,
    respondFirstChecked: false,
    currentPrediction: null,
    forceCheckPending: false,
    frustrationStreak: 0,
    currentWindowSize: 2,
    driftState: {},
    lastProcessedPlanApprovalToolUseId: null,
  };
}

type SessionStateManager = CacheManager<SessionState>;

/**
 * Re-export getSessionDir from cache-manager.
 * All session files live under ~/.agent-framework/sessions/{project}/{hash}/.
 */
export function getSessionDir(transcriptPath: string): string {
  return getSessionDirFromCacheManager(transcriptPath);
}

/**
 * Append a tool log entry to the session's JSONL tool log.
 */
export async function appendToolLog(sessionDir: string, entry: ToolLogEntry): Promise<void> {
  const logPath = path.join(sessionDir, "tool-log.jsonl");
  await fs.promises.appendFile(logPath, JSON.stringify(entry) + "\n");
}

/**
 * Read the last N entries from the tool log as parsed ToolLogEntry objects.
 */
export function readToolLogEntries(sessionDir: string, count: number): ToolLogEntry[] {
  const logPath = path.join(sessionDir, "tool-log.jsonl");
  try {
    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    const tail = lines.slice(-count);
    const entries: ToolLogEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as ToolLogEntry);
      } catch {
        // Skip malformed lines
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Format a brief description of a tool call for logging.
 */
export function formatToolDetail(toolName: string, toolInput: unknown): string {
  const input = toolInput as Record<string, unknown>;
  switch (toolName) {
    case "Edit":
      return `Edit ${input?.file_path ?? "unknown"}`;
    case "Bash": {
      const cmd = String(input?.command ?? "");
      return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
    }
    case "Read":
      return `Read ${input?.file_path ?? "unknown"}`;
    case "Glob":
      return `Glob ${input?.pattern ?? "unknown"}`;
    case "Grep":
      return `Grep ${input?.pattern ?? "unknown"}`;
    case "Write":
      return `Write ${input?.file_path ?? "unknown"}`;
    default:
      return toolName;
  }
}

/**
 * Get a CacheManager-based session state manager for the given session directory.
 */
export function getSessionState(sessionDir: string): SessionStateManager {
  return new CacheManager<SessionState>({
    filePath: path.join(sessionDir, "state.json"),
    defaultData: sessionStateDefaults,
  });
}

// Active subagent counter — consolidated in subagent-detector.ts
export { getActiveSubagentCount, incrementActiveSubagents, decrementActiveSubagents, resetActiveSubagents } from "./subagent-detector.js";
