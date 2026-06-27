import type { TranscriptEntry, TranscriptSource } from "../../src/adapter/types.js";
import { recordFromUnknown } from "../../src/utils/output.js";

export function timestampFromTranscriptRecord(value: unknown): string | null {
  const record = recordFromUnknown(value);
  const timestamp = record.timestamp ?? record.created_at ?? record.createdAt;
  return typeof timestamp === "string" && timestamp.length > 0 ? timestamp : null;
}

export function buildTranscriptSource(input: {
  adapter: string;
  sourceKey: string;
  transcriptPath?: string;
  startLine: number;
  endLine?: number;
  nativeId?: string | null;
  createdAt?: string | null;
}): TranscriptSource {
  return {
    adapter: input.adapter,
    sourceKey: input.sourceKey,
    ...(input.transcriptPath ? { transcriptPath: input.transcriptPath } : {}),
    startLine: input.startLine,
    endLine: input.endLine ?? input.startLine,
    ...(input.nativeId ? { nativeId: input.nativeId } : {}),
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  };
}

export function buildLineTranscriptSource(input: {
  adapter: string;
  kind: string;
  transcriptPath?: string;
  startLine: number;
  endLine?: number;
  nativeId?: string | null;
  raw?: unknown;
}): TranscriptSource {
  const sourceKey = input.nativeId
    ? `${input.adapter}:${input.kind}:${input.nativeId}`
    : `${input.adapter}:${input.kind}:${input.transcriptPath ?? "inline"}:${input.startLine}`;
  return buildTranscriptSource({
    adapter: input.adapter,
    sourceKey,
    transcriptPath: input.transcriptPath,
    startLine: input.startLine,
    endLine: input.endLine,
    nativeId: input.nativeId,
    createdAt: timestampFromTranscriptRecord(input.raw),
  });
}

export function withTranscriptSource(entry: TranscriptEntry, source: TranscriptSource): TranscriptEntry {
  const message = entry.message
    ? {
        ...entry.message,
        content: Array.isArray(entry.message.content)
          ? entry.message.content.map((block) => block.source ? block : { ...block, source })
          : entry.message.content,
      }
    : undefined;
  return {
    ...entry,
    source: entry.source ?? source,
    createdAt: entry.createdAt ?? source.createdAt,
    ...(message ? { message } : {}),
  };
}
