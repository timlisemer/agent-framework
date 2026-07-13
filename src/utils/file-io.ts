/**
 * File I/O — unified read/write helpers for all non-CacheManager file I/O.
 *
 * Provides:
 * - JSONL append (async + sync)
 * - JSONL read (with optional tail / byte-offset)
 * - JSONL write (full overwrite)
 * - JSON read/write
 * - Plain text append
 * - Atomic JSON read-modify-write via .lock sidecar
 *
 * All writers ensure the parent directory exists before writing.
 *
 * @module file-io
 */

import * as fs from "fs";
import * as path from "path";
import { type CancellationOptions, throwIfAborted } from "./cancellation.js";

export type ValidatedFileScanResult =
  | { kind: "text"; bytes: number; scannedBytes: number }
  | { kind: "binary"; bytes: number; scannedBytes: number }
  | { kind: "scan-limited"; bytes: number; scannedBytes: number }
  | { kind: "non-file"; fileType: "symbolic link" | "directory" | "special file"; scannedBytes: number }
  | { kind: "unreadable"; regularFile?: boolean; bytes?: number; scannedBytes: number };

/**
 * Validate and stream a regular file without following symlinks. This is the
 * single safety-sensitive read primitive for bounded repository file scans.
 */
export async function scanValidatedFileCancellable(
  filePath: string,
  options: CancellationOptions & {
    maxBytes: number;
    visitChunk?: (chunk: Buffer) => void;
  },
): Promise<ValidatedFileScanResult> {
  throwIfAborted(options.signal);
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(filePath);
  } catch {
    throwIfAborted(options.signal);
    return { kind: "unreadable", scannedBytes: 0 };
  }
  throwIfAborted(options.signal);
  if (!before.isFile()) {
    return {
      kind: "non-file",
      fileType: before.isSymbolicLink()
        ? "symbolic link"
        : before.isDirectory() ? "directory" : "special file",
      scannedBytes: 0,
    };
  }
  if (before.size > options.maxBytes) return { kind: "scan-limited", bytes: before.size, scannedBytes: 0 };

  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(
      filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
  } catch {
    throwIfAborted(options.signal);
    return { kind: "unreadable", regularFile: true, bytes: before.size, scannedBytes: 0 };
  }
  let total = 0;
  let visitorFailed = false;
  let visitorError: unknown;
  try {
    throwIfAborted(options.signal);
    const opened = await handle.stat();
    throwIfAborted(options.signal);
    const after = await fs.promises.lstat(filePath);
    throwIfAborted(options.signal);
    if (after.isSymbolicLink()) return { kind: "non-file", fileType: "symbolic link", scannedBytes: total };
    if (opened.dev !== after.dev || opened.ino !== after.ino) {
      return { kind: "unreadable", regularFile: true, bytes: opened.size, scannedBytes: total };
    }
    if (!opened.isFile()) {
      return { kind: "non-file", fileType: opened.isDirectory() ? "directory" : "special file", scannedBytes: total };
    }
    if (opened.size > options.maxBytes) return { kind: "scan-limited", bytes: opened.size, scannedBytes: 0 };

    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (true) {
      throwIfAborted(options.signal);
      let read: Awaited<ReturnType<typeof handle.read>>;
      try {
        read = await handle.read(buffer, 0, buffer.length, null);
      } catch {
        throwIfAborted(options.signal);
        return { kind: "unreadable", regularFile: true, bytes: opened.size, scannedBytes: total };
      }
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
      throwIfAborted(options.signal);
      if (total > options.maxBytes) {
        return { kind: "scan-limited", bytes: Math.max(opened.size, total), scannedBytes: total };
      }
      const chunk = buffer.subarray(0, read.bytesRead);
      if (chunk.includes(0)) return { kind: "binary", bytes: opened.size, scannedBytes: total };
      try {
        options.visitChunk?.(chunk);
      } catch (error) {
        visitorFailed = true;
        visitorError = error;
        throw error;
      }
    }
    return { kind: "text", bytes: total, scannedBytes: total };
  } catch {
    if (visitorFailed) throw visitorError;
    throwIfAborted(options.signal);
    return { kind: "unreadable", regularFile: true, bytes: before.size, scannedBytes: total };
  } finally {
    await handle.close().catch(() => undefined);
    throwIfAborted(options.signal);
  }
}

type JsonReplacer = (this: unknown, key: string, value: unknown) => unknown;
type JsonWriteOptions = { indent?: number; replacer?: JsonReplacer };

export function readFirstUtf8File(filePaths: readonly string[]): string | null {
  for (const filePath of filePaths) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Bounded no-follow UTF-8 read for instruction and configuration files. */
export async function readValidatedTextFileCancellable(
  filePath: string,
  options: CancellationOptions & { maxBytes?: number } = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const chunks: Buffer[] = [];
  const result = await scanValidatedFileCancellable(filePath, {
    ...options,
    maxBytes,
    visitChunk: (chunk) => chunks.push(Buffer.from(chunk)),
  });
  return result.kind === "text" ? Buffer.concat(chunks).toString("utf-8") : null;
}

export function listJsonlFilesRecursive(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const results: string[] = [];
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(fullPath);
      }
    }
  };
  visit(root);
  return results;
}

// ─── JSONL helpers ────────────────────────────────────────────────────────────

/**
 * Append a single JSON-serialisable entry as a newline-terminated JSON line.
 * Creates the file (and parent directories) if they don't exist.
 */
export async function appendJsonlEntry<T>(filePath: string, entry: T): Promise<void> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await fs.promises.appendFile(filePath, JSON.stringify(entry) + "\n");
}

/**
 * Synchronous variant of appendJsonlEntry.
 * Creates the file (and parent directories) if they don't exist.
 */
export function appendJsonlEntrySync<T>(filePath: string, entry: T): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n");
}

/**
 * Synchronously append multiple JSONL entries in one write.
 */
export function appendJsonlEntriesSync<T>(filePath: string, entries: readonly T[]): void {
  if (entries.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/**
 * Read a JSONL file and return parsed entries.
 *
 * @param filePath - Path to the .jsonl file
 * @param opts.tail - If set, return only the last N entries
 * @returns Array of parsed entries; empty array if file does not exist
 */
export function readJsonl<T>(
  filePath: string,
  opts?: { tail?: number },
): T[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  return parseJsonlText<T>(content, opts?.tail);
}

export function parseJsonlText<T>(content: string, tail?: number): T[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const slice = tail !== undefined ? lines.slice(-tail) : lines;
  return parseJsonlLines<T>(slice);
}

export function parseJsonlLines<T>(lines: readonly string[]): T[] {
  return parseJsonlLinesWithSequenceIds<T>(lines, 1).map((result) => result.entry);
}

function readFileTailWindow(
  filePath: string,
  maxBytes: number,
): { buffer: Buffer; start: number } | null {
  return readFileWindow(filePath, (size) => {
    const length = Math.min(maxBytes, size);
    return { start: size - length, length };
  });
}

function readFileWindow(
  filePath: string,
  select: (size: number) => { start: number; length: number },
): { buffer: Buffer; start: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const window = select(stat.size);
    const start = Math.max(0, Math.min(window.start, stat.size));
    const length = Math.max(0, Math.min(window.length, stat.size - start));
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      fs.readSync(fd, buffer, 0, length, start);
    }
    return { buffer, start };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

type JsonlTailWindow = {
  buffer: Buffer;
  start: number;
  previousByteIsNewline: boolean;
};

function readJsonlTailWindow(filePath: string, maxBytes: number): JsonlTailWindow | null {
  const window = readFileTailWindow(filePath, maxBytes);
  if (!window) return null;
  const previous = window.start > 0
    ? readFileWindow(filePath, () => ({ start: window.start - 1, length: 1 }))
    : null;
  return {
    ...window,
    previousByteIsNewline: window.start === 0 || previous?.buffer[0] === 10,
  };
}

export function readJsonlTail<T>(filePath: string, maxBytes: number, tail?: number): T[] {
  const window = readJsonlTailWindow(filePath, maxBytes);
  if (!window) return [];
  try {
    const entries = parseJsonlBufferWindow<T>(window.buffer, {
      dropLeadingPartial: !window.previousByteIsNewline,
      dropTrailingPartial: true,
    });
    return tail !== undefined ? entries.slice(-tail) : entries;
  } catch {
    return [];
  }
}

export interface JsonlEntryWithSequenceId<T> {
  sequenceId: number;
  entry: T;
}

export function readJsonlTailWithSequenceIds<T>(
  filePath: string,
  maxBytes: number,
  tail?: number
): JsonlEntryWithSequenceId<T>[] {
  const window = readJsonlTailWindow(filePath, maxBytes);
  if (!window) return [];
  try {
    const entries = parseJsonlBufferWindowWithSequenceIds<T>(window.buffer, {
      startSequenceId: boundedTailStartSequenceId(window.start),
      dropLeadingPartial: !window.previousByteIsNewline,
      dropTrailingPartial: true,
    });
    return tail !== undefined ? entries.slice(-tail) : entries;
  } catch {
    return [];
  }
}

export type JsonlTailReader<T> = {
  read(): T[];
};

export function createJsonlTailReader<T>(
  filePath: string,
  parse: (line: string) => T | null,
  opts?: { offset?: number }
): JsonlTailReader<T> {
  let offset = opts?.offset ?? fileSizeOrZero(filePath);
  let pending = "";

  return {
    read(): T[] {
      const size = fileSizeOrZero(filePath);
      if (size < offset) {
        offset = 0;
        pending = "";
      }
      if (size === offset) return [];

      let chunk = "";
      try {
        const window = readFileWindow(filePath, () => ({ start: offset, length: size - offset }));
        if (!window) return [];
        chunk = window.buffer.toString("utf8");
      } catch {
        return [];
      }
      offset = size;

      const text = pending + chunk;
      const lines = text.split("\n");
      pending = text.endsWith("\n") ? "" : lines.pop() ?? "";

      const entries: T[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const entry = parse(trimmed);
        if (entry) entries.push(entry);
      }
      return entries;
    },
  };
}

export function readLastJsonlEntryFromTail<T>(
  filePath: string,
  maxBytes: number,
): T | null {
  return readJsonlTail<T>(filePath, maxBytes).at(-1) ?? null;
}

/**
 * Read a JSONL file and return parsed entries from a supplied string.
 */
export function readJsonlFromText<T>(content: string, opts?: { tail?: number }): T[] {
  return parseJsonlText<T>(content, opts?.tail);
}

export function parseJsonlBufferWindow<T>(
  buffer: Buffer,
  opts?: { dropLeadingPartial?: boolean; dropTrailingPartial?: boolean },
): T[] {
  return parseJsonlText<T>(sliceJsonlWindowText(buffer, opts).text);
}

function parseJsonlBufferWindowWithSequenceIds<T>(
  buffer: Buffer,
  opts: { startSequenceId: number; dropLeadingPartial?: boolean; dropTrailingPartial?: boolean },
): JsonlEntryWithSequenceId<T>[] {
  const window = sliceJsonlWindowText(buffer, opts);
  return parseJsonlLinesWithSequenceIds<T>(
    window.text.split("\n"),
    opts.startSequenceId + window.skippedLeadingLines
  );
}

function sliceJsonlWindowText(
  buffer: Buffer,
  opts?: { dropLeadingPartial?: boolean; dropTrailingPartial?: boolean },
): { text: string; skippedLeadingLines: number } {
  let raw = buffer.toString("utf-8");
  let skippedLeadingLines = 0;
  if (opts?.dropLeadingPartial && raw.length > 0) {
    const firstNewline = raw.indexOf("\n");
    if (firstNewline === -1) {
      raw = "";
    } else {
      raw = raw.slice(firstNewline + 1);
      skippedLeadingLines = 1;
    }
  }
  if (opts?.dropTrailingPartial && raw.length > 0 && !raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n");
    raw = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  }
  return { text: raw, skippedLeadingLines };
}

function parseJsonlLinesWithSequenceIds<T>(
  lines: readonly string[],
  startSequenceId: number
): JsonlEntryWithSequenceId<T>[] {
  const results: JsonlEntryWithSequenceId<T>[] = [];
  let sequenceId = startSequenceId;
  for (const line of lines) {
    if (line.trim().length > 0) {
      try {
        results.push({ sequenceId, entry: JSON.parse(line) as T });
      } catch {
        // skip malformed lines
      }
    }
    sequenceId += 1;
  }
  return results;
}

function boundedTailStartSequenceId(startOffset: number): number {
  return startOffset <= 0 ? 1 : startOffset + 1;
}

export function readJsonlThroughByteOffset<T>(
  filePath: string,
  offset: number,
): T[] {
  const window = readFileWindow(filePath, (size) => ({
    start: 0,
    length: Math.max(0, Math.min(offset, size)),
  }));
  if (!window) return [];
  try {
    return parseJsonlBufferWindow<T>(window.buffer, {
      dropTrailingPartial: true,
    });
  } catch {
    return [];
  }
}

export function readJsonlAfterByteOffset<T>(
  filePath: string,
  offset: number,
): T[] {
  const previous = offset > 0
    ? readFileWindow(filePath, () => ({ start: offset - 1, length: 1 }))
    : null;
  const previousByteIsNewline = offset <= 0 || previous?.buffer[0] === 10;
  const window = readFileWindow(filePath, (size) => {
    const start = Math.max(0, Math.min(offset, size));
    return { start, length: size - start };
  });
  if (!window) return [];
  try {
    return parseJsonlBufferWindow<T>(window.buffer, {
      dropLeadingPartial: !previousByteIsNewline,
      dropTrailingPartial: true,
    });
  } catch {
    return [];
  }
}

/**
 * Read the last physical JSONL line from a file if it is parseable.
 * Returns null if the file is missing, empty, or the last line is malformed.
 */
export function readLastJsonlEntry<T>(filePath: string): T | null {
  return readJsonl<T>(filePath, { tail: 1 })[0] ?? null;
}

/**
 * Read JSONL entries until a predicate matches.
 * Malformed lines are skipped by readJsonl.
 */
export function findJsonlEntry<T>(
  filePath: string,
  predicate: (entry: T) => boolean,
): T | null {
  for (const entry of readJsonl<T>(filePath)) {
    try {
      if (predicate(entry)) return entry;
    } catch {
      // Skip syntactically valid but shape-invalid entries.
    }
  }
  return null;
}

/**
 * Write an array of entries to a JSONL file, overwriting any existing content.
 * Creates parent directories if necessary.
 */
export function writeJsonl<T>(filePath: string, entries: readonly T[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""));
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

/**
 * Write a value as formatted JSON to a file.
 * Creates parent directories if necessary.
 * Defaults to 2-space indentation with a trailing newline (matching project style).
 */
export function writeJson<T>(filePath: string, value: T, opts?: JsonWriteOptions): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, opts?.replacer, opts?.indent ?? 2) + "\n");
}

/**
 * Atomically write a value as formatted JSON via a same-directory temp file.
 * Creates parent directories if necessary.
 */
export function writeJsonAtomic<T>(filePath: string, value: T, opts?: JsonWriteOptions): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tempPath, JSON.stringify(value, opts?.replacer, opts?.indent ?? 2) + "\n");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Best-effort cleanup only; preserve the original write/rename failure.
    }
    throw error;
  }
}

/**
 * Read and parse a JSON file.
 * Throws if the file does not exist or is malformed.
 */
export function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

// ─── Text helpers ─────────────────────────────────────────────────────────────

export function readFileTailBuffer(filePath: string, maxBytes: number): Buffer | null {
  return readFileTailWindow(filePath, maxBytes)?.buffer ?? null;
}

export function readFileHeadBuffer(filePath: string, maxBytes: number): Buffer | null {
  return readFileWindow(filePath, () => ({ start: 0, length: maxBytes }))?.buffer ?? null;
}

export function fileSizeOrZero(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function fileMtimeMs(filePath: string, missingValue = -1): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return missingValue;
  }
}

/**
 * Append a plain text string to a file.
 * Creates parent directories if necessary.
 */
export function appendText(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, text);
}

// ─── Atomic JSON read-modify-write ────────────────────────────────────────────

const LOCK_RETRY_DELAY_MS = 10;
const LOCK_MAX_RETRIES = 100;

/**
 * Atomically read-modify-write a JSON file using a .lock sidecar.
 * Reads the current value (or default if absent), applies `fn`, writes back.
 * Retries up to LOCK_MAX_RETRIES times if the lock is held by another process.
 *
 * Use this for files shared across concurrent processes (e.g. mcp-state.json).
 */
export function updateJsonFile<T>(
  filePath: string,
  fn: (current: T | undefined) => T,
): void {
  const lockPath = filePath + ".lock";
  let acquired = false;
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      acquired = true;
      break;
    } catch {
      // Lock held — busy wait
      const deadline = Date.now() + LOCK_RETRY_DELAY_MS;
      while (Date.now() < deadline) { /* spin */ }
    }
  }
  try {
    let current: T | undefined;
    try {
      current = readJson<T>(filePath);
    } catch {
      current = undefined;
    }
    const next = fn(current);
    writeJson(filePath, next);
  } finally {
    if (acquired) {
      try {
        fs.unlinkSync(lockPath);
      } catch { /* best-effort */ }
    }
  }
}
