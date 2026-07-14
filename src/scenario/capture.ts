/**
 * Capture - append-only JSONL log of hook-fire events ("capture pointers").
 *
 * Each line records the essential metadata for one hook invocation: when it
 * fired, which epoch it belongs to, which state snapshot was current, what
 * decision was produced, and enough anchors to reconstruct the full scenario
 * via materializeScenario().
 *
 * File: <sessionDir>/captures.jsonl
 * Rotation: FIFO cap at AGENT_FRAMEWORK_CAPTURE_CAP entries (default 5000).
 *   Set to "0" to disable capture entirely.
 *
 * @module scenario/capture
 */

import * as fs from "fs";
import { appendJsonlEntrySync, findJsonlEntry, readLastJsonlEntry } from "../utils/file-io.js";
import { sessionCapturesFile } from "../utils/paths.js";
import type { PlanModeDetection } from "../adapter/types.js";
import type { PlanModeStoredState, PlanModeTransition } from "../utils/plan-mode-entry-state.js";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One hook-fire record appended to captures.jsonl. All fields are
 * intentionally nullable/optional so the format is forward-compatible.
 */
export interface CapturePointer {
  /** 1-based monotonic sequence number within this session. */
  seq: number;
  /** Wall-clock timestamp (Date.now()). */
  ts: number;
  /** Epoch id this capture belongs to. */
  epoch_id: string;
  /**
   * seq of the capture that triggered the previous epoch rotation, if any.
   * null for the first capture in a session.
   */
  parent_capture_seq: number | null;
  /** Hook event name (e.g. "PreToolUse"). */
  event: string;
  /** tool_use_id from the hook input, when applicable. */
  tool_use_id?: string;
  /** UUID of the user-prompt message that initiated this turn, when known. */
  prompt_uuid?: string;
  /**
   * UUID of the transcript line that serves as the epoch anchor - the deepest
   * line still present in the transcript after a rewind. Used by materialize
   * to slice the transcript correctly.
   */
  transcript_anchor_uuid?: string;
  /** Hook decision string (e.g. "allow", "deny", "ok", "error", "pass", "block"). */
  decision: string;
  /** Host permission_mode value observed by this hook. */
  permission_mode?: string | null;
  /** Plan-mode transition observed by this hook, when it ran the detector. */
  plan_mode?: {
    mode: string | null;
    source: string;
    detection_source?: string;
    previous?: PlanModeStoredState | null;
    current?: PlanModeStoredState;
    active: boolean;
    entered?: boolean;
    exited?: boolean;
  };
  /** session-injections.jsonl seqs appended by this hook. */
  injection_seqs?: number[];
  /** session-injections.jsonl message hashes appended by this hook. */
  injection_hashes?: string[];
  /**
   * seq of the state snapshot taken immediately before this hook fired.
   * Cross-references state-snapshots.jsonl.
   */
  state_snapshot_seq: number | null;
  /**
   * SHA-256 (first 16 hex chars) of the raw hook stdin JSON. Used to detect
   * replayed or duplicated captures when the same hook fires twice.
   */
  raw_input_hash?: string;
}

export type CapturePlanMode = NonNullable<CapturePointer["plan_mode"]>;

export function capturePlanModeFromDetection(
  detection: PlanModeDetection,
): CapturePlanMode {
  return {
    active: detection.active,
    mode: detection.mode,
    source: detection.source,
  };
}

export function capturePlanModeFromTransition(
  transition: PlanModeTransition,
): CapturePlanMode {
  return {
    mode: transition.mode,
    source: transition.detection_source,
    detection_source: transition.detection_source,
    previous: transition.previous,
    current: transition.current,
    active: transition.active,
    entered: transition.entered,
    exited: transition.exited,
  };
}

// ─── FIFO rotation cap ────────────────────────────────────────────────────────

function captureCap(): number {
  const raw = process.env.AGENT_FRAMEWORK_CAPTURE_CAP;
  if (raw !== undefined) {
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 5000;
}

/**
 * Enforce FIFO rotation: keep only the last `cap` lines of the file.
 * Called after every append. O(N) but cap is bounded.
 */
function rotateCapturesIfNeeded(filePath: string, cap: number): void {
  if (cap === 0) return; // capture disabled - nothing to rotate
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length <= cap) return;
  const kept = lines.slice(lines.length - cap);
  fs.writeFileSync(filePath, kept.join("\n") + "\n");
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the last seq number from the captures file.
 * Returns 0 when the file doesn't exist or is empty.
 */
function readLastSeq(filePath: string): number {
  const last = readLastJsonlEntry<{ seq?: number }>(filePath);
  return typeof last?.seq === "number" ? last.seq : 0;
}

/**
 * Append a single CapturePointer as one JSONL line to
 * `<sessionDir>/captures.jsonl`. Synchronous so callers in hook entry
 * points don't need to await.
 *
 * The `seq` field on the input pointer is ignored; the actual seq is
 * computed as last-seq + 1 so callers don't need to track it.
 *
 * When AGENT_FRAMEWORK_CAPTURE_CAP=0, this is a no-op.
 */
export function appendCapture(sessionDir: string, pointer: Omit<CapturePointer, "seq"> & { seq?: number }): void {
  const cap = captureCap();
  if (cap === 0) return;

  const filePath = sessionCapturesFile(sessionDir);
  try {
    const seq = readLastSeq(filePath) + 1;
    const record: CapturePointer = { ...pointer, seq };
    appendJsonlEntrySync(filePath, record);
    rotateCapturesIfNeeded(filePath, cap);
  } catch {
    // Best-effort - capture failures must never crash a hook process.
  }
}

/**
 * Load a single CapturePointer by its 1-based seq number.
 * Returns null when the file is missing, the seq is not found, or parsing fails.
 */
export function loadCapturePointer(
  sessionDir: string,
  seq: number,
): CapturePointer | null {
  return findJsonlEntry<CapturePointer>(
    sessionCapturesFile(sessionDir),
    (pointer) => pointer.seq === seq,
  );
}

export function findCaptureByToolUseId(
  sessionDir: string,
  toolUseId: string,
): CapturePointer | null {
  return findJsonlEntry<CapturePointer>(
    sessionCapturesFile(sessionDir),
    (pointer) => pointer.tool_use_id === toolUseId,
  );
}

export function findCaptureByInjectionSeq(
  sessionDir: string,
  injectionSeq: number,
): CapturePointer | null {
  return findJsonlEntry<CapturePointer>(
    sessionCapturesFile(sessionDir),
    (pointer) => pointer.injection_seqs?.includes(injectionSeq) === true,
  );
}
