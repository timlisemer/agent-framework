/**
 * Claude transcript parser.
 *
 * Claude Code already emits the canonical shape on each JSONL line —
 * each line is either a canonical message entry or a meta entry.
 * This parser is essentially identity: parse JSON, return as-is.
 *
 * @module adapters/claude/parse-transcript
 */

import type { TranscriptEntry, ContentBlock } from "../../src/adapter/types.js";

function normalizeEntry(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as TranscriptEntry & { payload?: unknown };

  // Claude Code already uses the canonical shape.
  if (entry.message) return entry as TranscriptEntry;

  // Meta entries (no message field) — preserve isMeta flag.
  return { isMeta: entry.isMeta };
}

export function parseTranscript(rawLines: readonly string[]): readonly (TranscriptEntry | null)[] {
  return rawLines.map((line) => {
    try {
      return normalizeEntry(JSON.parse(line));
    } catch {
      return null;
    }
  });
}

// Re-export ContentBlock so scenario-materializer can use it without importing from src/.
export type { ContentBlock };
