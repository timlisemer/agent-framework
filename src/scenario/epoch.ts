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
import * as fs from "fs";
import * as path from "path";
import { sessionEpochsFile } from "../utils/paths.js";

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
  /** Adapter name (always "claude" for now). */
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
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]) as Epoch;
  } catch {
    return null;
  }
}

function readLiveTranscriptUuids(transcriptPath: string): string[] {
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
    return uuids;
  } catch {
    return [];
  }
}

/**
 * Read the transcript_uuids_tail from the most-recent state snapshot.
 * Returns [] when no snapshots exist.
 */
function loadSnapshotUuidsTail(sessionDir: string): string[] {
  const snapshotFile = path.join(sessionDir, "state-snapshots.jsonl");
  let raw: string;
  try {
    raw = fs.readFileSync(snapshotFile, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  try {
    const last = JSON.parse(lines[lines.length - 1]) as { transcript_uuids_tail?: string[] };
    return last.transcript_uuids_tail ?? [];
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect whether a transcript rewind has occurred since the last snapshot.
 *
 * Returns `{rotated: false}` in any of these conditions:
 * - No prior state snapshot exists (fresh session, nothing to detect against).
 * - Running under replay (AGENT_FRAMEWORK_SESSION_DIR is set by replay.ts).
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
  // Skip detection in replay context — the session dir is synthetic.
  if (process.env.AGENT_FRAMEWORK_SESSION_DIR) {
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
    adapter: "claude",
  };

  try {
    fs.mkdirSync(path.dirname(epochsFile), { recursive: true });
    fs.appendFileSync(epochsFile, JSON.stringify(epoch) + "\n");
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
 * No-op when AGENT_FRAMEWORK_SESSION_DIR is set (replay context).
 */
export function initEpochSession(sessionDir: string): void {
  if (process.env.AGENT_FRAMEWORK_SESSION_DIR) return;
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
    adapter: "claude",
  };

  try {
    fs.mkdirSync(path.dirname(epochsFile), { recursive: true });
    fs.appendFileSync(epochsFile, JSON.stringify(epoch) + "\n");
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
