import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { EventName } from "../adapter/types.js";
import { sessionInjectionsFile } from "./paths.js";

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

export function shortContentHash(content: string): string {
  return crypto.createHash("sha256").update(Buffer.from(content, "utf-8")).digest("hex").slice(0, 16);
}

function parseRecordsFromBuffer(buffer: Buffer): SessionInjectionRecord[] {
  let raw = buffer.toString("utf-8");
  if (!raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n");
    raw = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  }

  const records: SessionInjectionRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as SessionInjectionRecord);
    } catch {
      // Skip malformed complete lines; a torn trailing line is dropped above.
    }
  }
  return records;
}

function readLastSeq(filePath: string): number {
  try {
    const records = parseRecordsFromBuffer(fs.readFileSync(filePath));
    return records.length > 0 ? records[records.length - 1].seq : 0;
  } catch {
    return 0;
  }
}

export function appendSessionInjections(
  sessionDir: string,
  event: EventName,
  pending: readonly PendingInjection[],
): SessionInjectionRecord[] {
  if (pending.length === 0) return [];

  const filePath = sessionInjectionsFile(sessionDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let seq = readLastSeq(filePath);
  const ts = Date.now();
  const records = pending.map((injection) => ({
    ...injection,
    seq: ++seq,
    ts,
    event,
    message_hash: shortContentHash(injection.message),
  }));
  fs.appendFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  return records;
}

export function readSessionInjectionsThroughOffset(
  sessionDir: string,
  offset: number,
): SessionInjectionRecord[] {
  try {
    const buffer = fs.readFileSync(sessionInjectionsFile(sessionDir));
    return parseRecordsFromBuffer(buffer.subarray(0, Math.max(0, Math.min(offset, buffer.length))));
  } catch {
    return [];
  }
}

export function readSessionInjectionsAfterOffset(
  sessionDir: string,
  offset: number,
): SessionInjectionRecord[] {
  try {
    const buffer = fs.readFileSync(sessionInjectionsFile(sessionDir));
    return parseRecordsFromBuffer(buffer.subarray(Math.max(0, Math.min(offset, buffer.length))));
  } catch {
    return [];
  }
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
