import fs from "node:fs";
import path from "node:path";
import type { AdapterResumeTarget, AdapterSessionHistoryMessage, AdapterSessionHistoryRecord } from "../../src/adapter/types.js";
import { listJsonlFilesRecursive, readJsonlTailWithSequenceIds } from "../../src/utils/file-io.js";

export const MANAGED_SESSION_MAX_FILE_BYTES = 256 * 1024;

export type JsonObject = Record<string, unknown>;
export type JsonPath = readonly string[];

export type ManagedSessionRecordInput = {
  adapterName: string;
  filePath: string;
  defaultSessionId: string;
  workingDirPaths: readonly JsonPath[];
  sessionIdPaths: readonly JsonPath[];
  roleFor: (raw: JsonObject) => AdapterSessionHistoryMessage["role"] | null;
  sessionIdFor?: (raw: JsonObject) => string | null;
  textPaths: readonly JsonPath[];
  contentPaths: readonly JsonPath[];
  fallbackWorkingDir?: (filePath: string) => string | null;
  targetKeyFor: (sessionId: string, filePath: string) => string;
  resumeTargetFor: (sessionId: string, filePath: string) => AdapterResumeTarget;
};

export function listManagedSessionRecords(input: {
  root: string;
  maxResults: number;
  readRecord: (filePath: string) => AdapterSessionHistoryRecord | null;
}): AdapterSessionHistoryRecord[] {
  const files = listJsonlFilesRecursive(input.root)
    .sort((a, b) => compareDesc(fileMtime(a), fileMtime(b), a, b));
  const records: AdapterSessionHistoryRecord[] = [];
  for (const file of files) {
    try {
      const record = input.readRecord(file);
      if (record) records.push(record);
    } catch {
      // Concurrently removed or unreadable transcript; skip it.
    }
    if (records.length >= input.maxResults) break;
  }
  return records;
}

export function readManagedSessionRecord(input: ManagedSessionRecordInput): AdapterSessionHistoryRecord | null {
  const entries = readJsonlTailWithSequenceIds<JsonObject>(input.filePath, MANAGED_SESSION_MAX_FILE_BYTES);
  const messages: AdapterSessionHistoryMessage[] = [];
  let workingDir: string | null = null;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  let summary = "";
  let sessionId = input.defaultSessionId;

  for (const { entry: raw, sequenceId } of entries) {
    const cwd = firstStringAt(raw, input.workingDirPaths);
    if (cwd && !workingDir) workingDir = path.resolve(cwd);
    const timestamp = firstStringAt(raw, [["timestamp"], ["created_at"], ["createdAt"]]);
    if (timestamp) {
      createdAt ??= timestamp;
      updatedAt = timestamp;
    }
    const id = input.sessionIdFor?.(raw) ?? firstStringAt(raw, input.sessionIdPaths);
    if (id) sessionId = id;
    const role = input.roleFor(raw);
    const text = extractText(raw, input.textPaths, input.contentPaths);
    if (role && text) {
      messages.push({ sequenceId, role, text, ...(timestamp ? { createdAt: timestamp } : {}) });
      if (!summary && role === "user") summary = firstLine(text);
    }
  }

  const stat = safeStat(input.filePath);
  updatedAt ??= stat?.mtime.toISOString();
  createdAt ??= stat?.birthtime.toISOString();
  workingDir ??= input.fallbackWorkingDir?.(input.filePath) ?? null;
  if (!workingDir) return null;
  summary ||= path.basename(workingDir);
  return {
    adapterName: input.adapterName,
    targetKey: input.targetKeyFor(sessionId, input.filePath),
    summary,
    workingDir,
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    resumeTarget: input.resumeTargetFor(sessionId, input.filePath),
    messages,
  };
}

export function firstStringAt(raw: JsonObject, paths: readonly JsonPath[]): string | null {
  for (const keys of paths) {
    const value = stringAt(raw, keys);
    if (value) return value;
  }
  return null;
}

export function stringAt(raw: JsonObject, keys: JsonPath): string | null {
  const value = valueAt(raw, keys);
  return typeof value === "string" && value.trim() ? value : null;
}

export function valueAt(raw: JsonObject, keys: JsonPath): unknown {
  let current: unknown = raw;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as JsonObject)[key];
  }
  return current;
}

function extractText(
  raw: JsonObject,
  textPaths: readonly JsonPath[],
  contentPaths: readonly JsonPath[]
): string | null {
  const direct = firstStringAt(raw, textPaths);
  if (direct) return direct;
  for (const path of contentPaths) {
    const content = valueAt(raw, path);
    if (!Array.isArray(content)) continue;
    const text = content.map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      return typeof (item as { text?: unknown }).text === "string" ? (item as { text: string }).text : "";
    }).filter(Boolean).join("\n");
    if (text) return text;
  }
  return null;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 120) ?? "Untitled session";
}

function safeStat(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function fileMtime(filePath: string): string {
  return safeStat(filePath)?.mtime.toISOString() ?? "";
}

function compareDesc(left: string | undefined, right: string | undefined, a: string, b: string): number {
  return (left ?? "") === (right ?? "") ? a.localeCompare(b) : (left ?? "") > (right ?? "") ? -1 : 1;
}
