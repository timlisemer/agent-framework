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
  const results: T[] = [];
  for (const line of lines) {
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
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

export function readJsonlTail<T>(filePath: string, maxBytes: number, tail?: number): T[] {
  const window = readFileTailWindow(filePath, maxBytes);
  if (!window) return [];
  const previous = window.start > 0
    ? readFileWindow(filePath, () => ({ start: window.start - 1, length: 1 }))
    : null;
  const previousByteIsNewline = window.start === 0 || previous?.buffer[0] === 10;
  try {
    const entries = parseJsonlBufferWindow<T>(window.buffer, {
      dropLeadingPartial: !previousByteIsNewline,
      dropTrailingPartial: true,
    });
    return tail !== undefined ? entries.slice(-tail) : entries;
  } catch {
    return [];
  }
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
  let raw = buffer.toString("utf-8");
  if (opts?.dropLeadingPartial && raw.length > 0) {
    const firstNewline = raw.indexOf("\n");
    raw = firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
  }
  if (opts?.dropTrailingPartial && raw.length > 0 && !raw.endsWith("\n")) {
    const lastNewline = raw.lastIndexOf("\n");
    raw = lastNewline === -1 ? "" : raw.slice(0, lastNewline + 1);
  }
  return parseJsonlText<T>(raw);
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
export function writeJsonl<T>(filePath: string, entries: T[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""));
}

// ─── JSON helpers ─────────────────────────────────────────────────────────────

/**
 * Write a value as formatted JSON to a file.
 * Creates parent directories if necessary.
 * Defaults to 2-space indentation with a trailing newline (matching project style).
 */
export function writeJson<T>(filePath: string, value: T, opts?: { indent?: number }): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, opts?.indent ?? 2) + "\n");
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
