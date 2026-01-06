import * as crypto from "crypto";

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
