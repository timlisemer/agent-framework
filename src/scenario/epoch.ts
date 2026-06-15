/**
 * Epoch — transcript-continuity boundaries for session state.
 *
 * An epoch is a contiguous slice of the transcript during which state
 * (predictions, drift, tool-log, gate-reasoning) was accumulated. A new
 * epoch starts whenever the host agent "rewinds" the transcript (e.g. a /clear
 * or context-compact that truncates history) or when the user explicitly
 * compacts the session.
 *
 * Detection algorithm:
 *   1. Read the most-recent state snapshot's transcript_uuids_tail.
 *   2. Read the live transcript and collect its UUIDs.
 *   3. If any UUID from the tail is missing from the live set, a rewind
 *      occurred. The deepest still-present old UUID is the anchorUuid.
 *   4. If hookHint.sessionStartSource === "compact", rotate with reason "compact".
 *
 * File: <sessionDir>/epochs.jsonl
 *
 * @module scenario/epoch
 */

import * as crypto from "crypto";
import * as path from "path";
import { appendJsonlEntrySync, readLastJsonlEntry } from "../utils/file-io.js";
import { isTestRunSessionDir, sessionEpochsFile } from "../utils/paths.js";
import { readTranscriptUuids } from "./transcript-uuids.js";
import { activeSpec } from "../adapter/spec.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Epoch {
  /** Unique epoch id (UUID v4). */
  id: string;
  /** Wall-clock timestamp (Date.now()) when this epoch started. */
  started_at: number;
  /** Human-readable reason: "initial" | "rewind" | "compact". */
  reason: "initial" | "rewind" | "compact";
  /**
   * UUID of the deepest transcript line still present after the rewind.
   * null for initial epochs and compact rotations (no anchor survives).
   */
  anchor_uuid: string | null;
  /** id of the epoch this one replaces. null for the very first epoch. */
  parent_epoch_id: string | null;
  /** Adapter name active when the epoch was recorded. */
  adapter: string;
}

export interface EpochChangeResult {
  rotated: boolean;
  reason?: Epoch["reason"];
  anchorUuid?: string | null;
}

// ─── Module-level state (per-process) ─────────────────────────────────────────

let initialized = false;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadLastEpoch(filePath: string): Epoch | null {
  return readLastJsonlEntry<Epoch>(filePath);
}

function readLiveTranscriptUuids(transcriptPath: string): string[] {
  return readTranscriptUuids(transcriptPath);
}

/**
 * Read the transcript_uuids_tail from the most-recent state snapshot.
 * Returns [] when no snapshots exist.
 */
function loadSnapshotUuidsTail(sessionDir: string): string[] {
  const snapshotFile = path.join(sessionDir, "state-snapshots.jsonl");
  const last = readLastJsonlEntry<{ transcript_uuids_tail?: string[] }>(snapshotFile);
  return last?.transcript_uuids_tail ?? [];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect whether a transcript rewind has occurred since the last snapshot.
 *
 * Returns `{rotated: false}` in any of these conditions:
 * - No prior state snapshot exists (fresh session, nothing to detect against).
 * - Running under scenario/replay test-runs cache sessions.
 * - All prior UUIDs are still present in the live transcript.
 *
 * Returns `{rotated: true, reason, anchorUuid}` when a rewind is detected or
 * hookHint indicates a compact source.
 */
export function detectEpochChange(
  sessionDir: string,
  transcriptPath: string,
  hookHint?: { sessionStartSource?: string },
): EpochChangeResult {
  // Skip detection in replay/scenario context — the session dir is synthetic.
  if (isTestRunSessionDir(sessionDir)) {
    return { rotated: false };
  }

  // compact hint from session-start takes priority.
  if (hookHint?.sessionStartSource === "compact") {
    return { rotated: true, reason: "compact", anchorUuid: null };
  }

  const tail = loadSnapshotUuidsTail(sessionDir);
  if (tail.length === 0) {
    // No prior snapshots — nothing to compare against.
    return { rotated: false };
  }

  const liveUuids = readLiveTranscriptUuids(transcriptPath);
  const liveSet = new Set(liveUuids);

  // Check if any tail UUID is missing from the live transcript.
  const missingInLive = tail.filter((u) => !liveSet.has(u));
  if (missingInLive.length === 0) {
    return { rotated: false };
  }

  // Find the deepest still-present old UUID (anchor).
  // Walk tail from most-recent back until we find one in liveSet.
  let anchorUuid: string | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (liveSet.has(tail[i])) {
      anchorUuid = tail[i];
      break;
    }
  }

  return { rotated: true, reason: "rewind", anchorUuid };
}

/**
 * Append a new Epoch record to `<sessionDir>/epochs.jsonl` and return it.
 */
export function rotateEpoch(
  sessionDir: string,
  reason: Epoch["reason"],
  anchor_uuid: string | null,
): Epoch {
  const epochsFile = sessionEpochsFile(sessionDir);
  const last = loadLastEpoch(epochsFile);

  const epoch: Epoch = {
    id: crypto.randomUUID(),
    started_at: Date.now(),
    reason,
    anchor_uuid,
    parent_epoch_id: last?.id ?? null,
    adapter: activeSpec().name,
  };

  try {
    appendJsonlEntrySync(epochsFile, epoch);
  } catch {
    // Best-effort.
  }

  return epoch;
}

/**
 * Lazily initialize the epoch session: ensure at least one epoch record
 * exists for this session (writes the "initial" epoch on first call).
 * Called from `hook-bootstrap.ts:initHookProcess` on every hook start.
 *
 * No-op for scenario/replay test-runs cache sessions.
 */
export function initEpochSession(sessionDir: string): void {
  if (isTestRunSessionDir(sessionDir)) return;
  if (initialized) return;
  initialized = true;

  const epochsFile = sessionEpochsFile(sessionDir);
  const last = loadLastEpoch(epochsFile);
  if (last !== null) return; // already initialized

  // First hook of this session — write the initial epoch.
  const epoch: Epoch = {
    id: crypto.randomUUID(),
    started_at: Date.now(),
    reason: "initial",
    anchor_uuid: null,
    parent_epoch_id: null,
    adapter: activeSpec().name,
  };

  try {
    appendJsonlEntrySync(epochsFile, epoch);
  } catch {
    // Best-effort.
  }
}

/**
 * Read the most-recent epoch from `<sessionDir>/epochs.jsonl`.
 * Returns null when the file doesn't exist or is empty.
 */
export function loadCurrentEpoch(sessionDir: string): Epoch | null {
  return loadLastEpoch(sessionEpochsFile(sessionDir));
}
