import { readJsonl, readJsonlTail } from "../utils/file-io.js";

function collectUuids(entries: readonly unknown[]): string[] {
  const uuids: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const uuid = record.uuid;
    if (typeof uuid === "string") uuids.push(uuid);
  }
  return uuids;
}

export function readTranscriptUuids(transcriptPath: string): string[] {
  return collectUuids(readJsonl<Record<string, unknown>>(transcriptPath));
}

export function readTranscriptUuidTail(
  transcriptPath: string,
  maxBytes: number,
  count: number,
): string[] {
  return collectUuids(readJsonlTail<Record<string, unknown>>(transcriptPath, maxBytes)).slice(-count);
}
