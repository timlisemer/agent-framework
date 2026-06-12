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
 * Read a JSONL file and return parsed entries.
 *
 * @param filePath - Path to the .jsonl file
 * @param opts.tail - If set, return only the last N entries
 * @param opts.byteOffset - If set, read only bytes starting at this offset
 * @returns Array of parsed entries; empty array if file does not exist
 */
export function readJsonl<T>(
  filePath: string,
  opts?: { tail?: number; byteOffset?: number },
): T[] {
  let content: string;
  try {
    if (opts?.byteOffset !== undefined) {
      const fd = fs.openSync(filePath, "r");
      try {
        const stat = fs.fstatSync(fd);
        if (stat.size <= opts.byteOffset) return [];
        const len = stat.size - opts.byteOffset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, opts.byteOffset);
        content = buf.toString("utf-8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(filePath, "utf-8");
    }
  } catch {
    return [];
  }

  const lines = content.split("\n").filter(Boolean);
  const slice = opts?.tail !== undefined ? lines.slice(-opts.tail) : lines;
  const results: T[] = [];
  for (const line of slice) {
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed lines
    }
  }
  return results;
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
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const length = Math.min(maxBytes, stat.size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer;
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
