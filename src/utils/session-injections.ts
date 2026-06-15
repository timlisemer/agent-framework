import type { EventName } from "../adapter/types.js";
import { appendJsonlEntriesSync, readJsonlAfterByteOffset, readJsonlThroughByteOffset, readJsonlTail } from "./file-io.js";
import { shortContentHash } from "./hash-utils.js";
import { sessionInjectionsFile } from "./paths.js";
export { shortContentHash } from "./hash-utils.js";

export type InjectionChannel = "context";

export interface InjectionSourceFile {
  kind: "file";
  path: string;
  content: string;
  content_hash: string;
}

export interface PendingInjection {
  id: string;
  trigger: string;
  channel: InjectionChannel;
  message: string;
  source_file?: InjectionSourceFile;
  metadata?: Record<string, unknown>;
}

export interface SessionInjectionRecord extends PendingInjection {
  seq: number;
  ts: number;
  event: EventName;
  message_hash: string;
}

function readRecentRecords(filePath: string): SessionInjectionRecord[] {
  return readJsonlTail<SessionInjectionRecord>(filePath, 64 * 1024);
}

function readLastSeq(filePath: string): number {
  const records = readRecentRecords(filePath);
  return records.length > 0 ? records[records.length - 1].seq : 0;
}

export function appendSessionInjections(
  sessionDir: string,
  event: EventName,
  pending: readonly PendingInjection[],
): SessionInjectionRecord[] {
  if (pending.length === 0) return [];

  const filePath = sessionInjectionsFile(sessionDir);
  let seq = readLastSeq(filePath);
  const recentKeys = new Set(
    readRecentRecords(filePath).map((record) => `${record.id}:${record.message_hash}`),
  );
  const deduped = pending.filter((injection) => {
    const key = `${injection.id}:${shortContentHash(injection.message)}`;
    if (recentKeys.has(key)) return false;
    recentKeys.add(key);
    return true;
  });
  if (deduped.length === 0) return [];

  const ts = Date.now();
  const records = deduped.map((injection) => ({
    ...injection,
    seq: ++seq,
    ts,
    event,
    message_hash: shortContentHash(injection.message),
  }));
  appendJsonlEntriesSync(filePath, records);
  return records;
}

export function readSessionInjectionsThroughOffset(
  sessionDir: string,
  offset: number,
): SessionInjectionRecord[] {
  return readJsonlThroughByteOffset<SessionInjectionRecord>(
    sessionInjectionsFile(sessionDir),
    offset,
  );
}

export function readSessionInjectionsAfterOffset(
  sessionDir: string,
  offset: number,
): SessionInjectionRecord[] {
  return readJsonlAfterByteOffset<SessionInjectionRecord>(
    sessionInjectionsFile(sessionDir),
    offset,
  );
}

export function loadSessionInjectionsBySeq(
  sessionDir: string,
  seqs: readonly number[],
): SessionInjectionRecord[] {
  if (seqs.length === 0) return [];
  const wanted = new Set(seqs);
  return readSessionInjectionsThroughOffset(sessionDir, Number.MAX_SAFE_INTEGER)
    .filter((record) => wanted.has(record.seq));
}

export function combineInjectionMessages(records: readonly SessionInjectionRecord[]): string {
  return records.map((record) => record.message).join("\n\n");
}
