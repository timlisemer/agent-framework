/**
 * State Snapshot - point-in-time freeze of hook-observable session state.
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

import * as fs from "fs";
import { appendJsonlEntrySync, fileSizeOrZero, findJsonlEntry, readLastJsonlEntryFromTail } from "../utils/file-io.js";
import { sessionStateSnapshotsFile, sessionToolLogFile, sessionGateReasoningFile, sessionPlanModeStateFile, sessionInjectionsFile } from "../utils/paths.js";
import type { SessionState } from "../utils/session-store.js";
import { parsePlanModeStoredState, type PlanModeStoredState } from "../utils/plan-mode-entry-state.js";
import { readTranscriptUuidTail } from "./transcript-uuids.js";
import { hashFileSha256Prefix, hashSha256Prefix } from "../utils/hash-utils.js";

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
  return hashSha256Prefix(data);
}

function fileHash(filePath: string): string | null {
  return hashFileSha256Prefix(filePath);
}

function readPlanModeState(filePath: string): PlanModeStoredState | null {
  try {
    return parsePlanModeStoredState(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return null;
  }
}

const TRANSCRIPT_UUID_TAIL_COUNT = 20;
const JSONL_TAIL_BYTES = 256 * 1024;

function readTranscriptUuidsTail(transcriptPath: string): string[] {
  return readTranscriptUuidTail(transcriptPath, JSONL_TAIL_BYTES, TRANSCRIPT_UUID_TAIL_COUNT);
}

function loadLastSnapshot(filePath: string): StateSnapshot | null {
  return readLastJsonlEntryFromTail<StateSnapshot>(filePath, JSONL_TAIL_BYTES);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Append a new StateSnapshot to `<sessionDir>/state-snapshots.jsonl` when
 * ANY of the tracked dimensions changed since the last snapshot:
 * - SessionState (hashed as JSON)
 * - tool-log.jsonl size (byte offset)
 * - gate-reasoning.json hash
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
  const planModePath = sessionPlanModeStateFile(sessionDir);
  const injectionsPath = sessionInjectionsFile(sessionDir);

  const stateHash = shortHash(JSON.stringify(state));
  const toolLogOffset = fileSizeOrZero(toolLogPath);
  const gateReasoningHash = fileHash(gateReasoningPath);
  const planModeState = readPlanModeState(planModePath);
  const planModeStateHash = shortHash(JSON.stringify(planModeState));
  const injectionLogOffset = fileSizeOrZero(injectionsPath);
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
    plan_mode_state: planModeState,
    injection_log_offset: injectionLogOffset,
    injection_log_hash: injectionLogHash,
    transcript_uuids_tail: transcriptUuidsTail,
  };

  try {
    appendJsonlEntrySync(filePath, snapshot);
  } catch {
    // Best-effort - snapshot failures must never crash a hook process.
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
  return findJsonlEntry<StateSnapshot>(
    sessionStateSnapshotsFile(sessionDir),
    (snapshot) => snapshot.seq === seq,
  );
}
