import * as crypto from "crypto";
import * as fs from "fs";

/**
 * Create a short MD5 hash of a string.
 *
 * Used for cache keys where collision resistance is less critical
 * than storage efficiency. 8 hex chars = 32 bits = 4 billion combinations.
 *
 * @param input - String to hash
 * @returns 8-character hex hash
 */
export function hashString(input: string): string {
  return crypto.createHash("md5").update(input).digest("hex").slice(0, 8);
}

export function hashSha256Prefix(input: string | Buffer, length = 16): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function hashSha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function shortContentHash(content: string): string {
  return hashSha256Prefix(Buffer.from(content, "utf-8"));
}

export function hashFileSha256Prefix(filePath: string, length = 16): string | null {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return null;
  }
  try {
    const hash = crypto.createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let bytesRead = 0;
    do {
      bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead > 0) {
        hash.update(buffer.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);
    return hash.digest("hex").slice(0, length);
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => item === undefined ? null : stableJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .sort()
        .map((key) => [key, stableJsonValue((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
