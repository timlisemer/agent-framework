/**
 * Claude transcript parser.
 *
 * Claude Code already emits the canonical shape on each JSONL line -
 * each line is either a canonical message entry or a meta entry.
 * This parser is essentially identity: parse JSON, return as-is.
 *
 * @module adapters/claude/parse-transcript
 */

import type {
  TranscriptEntry,
  TranscriptParseOptions,
  TranscriptSource,
} from "../../src/adapter/types.js";
import { nonEmptyStringField, recordFromUnknown } from "../../src/utils/output.js";
import { buildLineTranscriptSource, withTranscriptSource } from "../shared/transcript-source.js";

/** Claude hook tool-use IDs and transcript tool-use IDs share this prefix. */
export function canInferUnflushedParallelToolUse(toolUseId: string): boolean {
  return toolUseId.startsWith("toolu_");
}

function normalizeEntry(raw: unknown, source: TranscriptSource): TranscriptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as TranscriptEntry & { payload?: unknown };

  // Claude Code already uses the canonical shape.
  if (entry.message) return withTranscriptSource(entry as TranscriptEntry, source);

  // Meta entries (no message field) - preserve isMeta flag.
  return { isMeta: entry.isMeta ?? true, source, createdAt: source.createdAt };
}

export function parseTranscript(
  rawLines: readonly string[],
  options: TranscriptParseOptions = {}
): readonly (TranscriptEntry | null)[] {
  return rawLines.map((line, index) => {
    const lineNumber = (options.startLine ?? 1) + index;
    try {
      const raw = JSON.parse(line) as unknown;
      return normalizeEntry(raw, sourceFor(raw, lineNumber, options));
    } catch {
      return null;
    }
  });
}

export function transcriptMessageGroupKey(entry: TranscriptEntry): string | null {
  if (entry.message?.role !== "assistant") return null;
  return typeof entry.message.id === "string" && entry.message.id ? entry.message.id : null;
}

function sourceFor(raw: unknown, lineNumber: number, options: TranscriptParseOptions): TranscriptSource {
  const record = recordFromUnknown(raw);
  const message = recordFromUnknown(record.message);
  const nativeId = nonEmptyStringField(record, "uuid") ??
    nonEmptyStringField(message, "id") ??
    nonEmptyStringField(record, "id");
  return buildLineTranscriptSource({
    adapter: "claude",
    kind: "entry",
    transcriptPath: options.transcriptPath,
    startLine: lineNumber,
    nativeId,
    raw,
  });
}
