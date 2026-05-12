/**
 * State Snapshot — point-in-time freeze of hook-observable session state.
 *
 * A snapshot is written immediately before each hook fires (or after a
 * significant state change). Snapshots are deduplicated: a new snapshot is
 * only appended when at least ONE of the tracked dimensions changed since the
 * last snapshot.
 *
 * File: <sessionDir>/state-snapshots.jsonl
 *
 * @module scenario/snapshot
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { sessionStateSnapshotsFile, sessionToolLogFile, sessionGateReasoningFile, sessionDenialCacheFile, sessionPlanModeStateFile, sessionInjectionsFile } from "../utils/paths.js";
import type { SessionState } from "../utils/session-store.js";
import type { PlanModeStoredState } from "../utils/plan-mode-entry-state.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StateSnapshot {
  /** 1-based monotonic sequence number within this session. */
  seq: number;
  /** Wall-clock timestamp (Date.now()). */
  ts: number;
  /** Full SessionState at snapshot time. */
  state: SessionState;
  /**
   * Byte offset immediately after the trailing newline of the most-recent
   * tool-log entry. Equivalently: fs.statSync(tool-log.jsonl).size at
   * snapshot time. Used to slice the tool log during materialization.
   */
  tool_log_offset: number;
  /** SHA-256 (first 16 hex chars) of gate-reasoning.json content, or null when absent. */
  gate_reasoning_hash: string | null;
  /** SHA-256 (first 16 hex chars) of hook-denials.json content, or null when absent. */
  denials_hash: string | null;
  /** Current persisted plan-mode sidecar state, or null when absent/corrupt. */
  plan_mode_state: PlanModeStoredState | null;
  /** Byte offset immediately after the most-recent session-injections entry. */
  injection_log_offset: number;
  /** SHA-256 (first 16 hex chars) of session-injections.jsonl content, or null when absent. */
  injection_log_hash: string | null;
  /**
   * The last N UUIDs (parentUuid fields) seen in the transcript at snapshot
   * time. Used by epoch detection to identify rewind boundaries.
   */
  transcript_uuids_tail: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function shortHash(data: string): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function fileHash(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return shortHash(content);
  } catch {
    return null;
  }
}

function readPlanModeState(filePath: string): PlanModeStoredState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Partial<PlanModeStoredState>;
    if (typeof parsed.active !== "boolean") return null;
    return {
      active: parsed.active,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
      lastSource: parsed.lastSource === "SessionStart" || parsed.lastSource === "UserPromptSubmit"
        ? parsed.lastSource
        : "UserPromptSubmit",
      permission_mode: typeof parsed.permission_mode === "string" ? parsed.permission_mode : null,
      detection_source: parsed.detection_source === "hook-input" || parsed.detection_source === "transcript-tail"
        ? parsed.detection_source
        : "transcript-tail",
    };
  } catch {
    return null;
  }
}

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

const TRANSCRIPT_UUID_TAIL_COUNT = 20;

function readTranscriptUuidsTail(transcriptPath: string): string[] {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const uuids: string[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const uuid = parsed.uuid as string | undefined;
        if (uuid && typeof uuid === "string") uuids.push(uuid);
      } catch {
        // skip
      }
    }
    return uuids.slice(-TRANSCRIPT_UUID_TAIL_COUNT);
  } catch {
    return [];
  }
}

function loadLastSnapshot(filePath: string): StateSnapshot | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as StateSnapshot;
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a new StateSnapshot to `<sessionDir>/state-snapshots.jsonl` when
 * ANY of the tracked dimensions changed since the last snapshot:
 * - SessionState (hashed as JSON)
 * - tool-log.jsonl size (byte offset)
 * - gate-reasoning.json hash
 * - hook-denials.json hash
 * - transcript_uuids_tail
 *
 * Returns the seq of the new snapshot (>=1), or the seq of the existing
 * unchanged snapshot (0 if no snapshot has been written yet and nothing changed).
 */
export function appendStateSnapshot(
  sessionDir: string,
  state: SessionState,
  transcriptPath: string,
): number {
  const filePath = sessionStateSnapshotsFile(sessionDir);

  const toolLogPath = sessionToolLogFile(sessionDir);
  const gateReasoningPath = sessionGateReasoningFile(sessionDir);
  const denialsPath = sessionDenialCacheFile(sessionDir);
  const planModePath = sessionPlanModeStateFile(sessionDir);
  const injectionsPath = sessionInjectionsFile(sessionDir);

  const stateHash = shortHash(JSON.stringify(state));
  const toolLogOffset = fileSize(toolLogPath);
  const gateReasoningHash = fileHash(gateReasoningPath);
  const denialsHash = fileHash(denialsPath);
  const planModeState = readPlanModeState(planModePath);
  const planModeStateHash = shortHash(JSON.stringify(planModeState));
  const injectionLogOffset = fileSize(injectionsPath);
  const injectionLogHash = fileHash(injectionsPath);
  const transcriptUuidsTail = readTranscriptUuidsTail(transcriptPath);
  const uuidsTailHash = shortHash(JSON.stringify(transcriptUuidsTail));

  const last = loadLastSnapshot(filePath);

  if (last !== null) {
    const lastStateHash = shortHash(JSON.stringify(last.state));
    const lastUuidsTailHash = shortHash(JSON.stringify(last.transcript_uuids_tail));
    const unchanged =
      lastStateHash === stateHash &&
      last.tool_log_offset === toolLogOffset &&
      last.gate_reasoning_hash === gateReasoningHash &&
      last.denials_hash === denialsHash &&
      shortHash(JSON.stringify(last.plan_mode_state ?? null)) === planModeStateHash &&
      (last.injection_log_offset ?? 0) === injectionLogOffset &&
      (last.injection_log_hash ?? null) === injectionLogHash &&
      lastUuidsTailHash === uuidsTailHash;
    if (unchanged) {
      return last.seq;
    }
  }

  const seq = last !== null ? last.seq + 1 : 1;
  const snapshot: StateSnapshot = {
    seq,
    ts: Date.now(),
    state,
    tool_log_offset: toolLogOffset,
    gate_reasoning_hash: gateReasoningHash,
    denials_hash: denialsHash,
    plan_mode_state: planModeState,
    injection_log_offset: injectionLogOffset,
    injection_log_hash: injectionLogHash,
    transcript_uuids_tail: transcriptUuidsTail,
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(snapshot) + "\n");
  } catch {
    // Best-effort — snapshot failures must never crash a hook process.
  }

  return seq;
}

/**
 * Load a StateSnapshot by its 1-based seq number from
 * `<sessionDir>/state-snapshots.jsonl`.
 * Returns null when not found or on parse error.
 */
export function loadStateSnapshot(
  sessionDir: string,
  seq: number,
): StateSnapshot | null {
  const filePath = sessionStateSnapshotsFile(sessionDir);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as StateSnapshot;
      if (parsed.seq === seq) return parsed;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}
