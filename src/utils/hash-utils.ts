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

export function hashSha256Prefix(input: string | Uint8Array, length = 16): string {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, length);
}

export function hashSha256(input: string | Uint8Array): string {
  return crypto.createHash("sha256").update(input).digest("hex");
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
