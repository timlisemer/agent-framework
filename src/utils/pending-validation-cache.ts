import * as path from "path";
import { CacheManager } from "./cache-manager.js";

const PENDING_VALIDATION_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Represents a pending or completed async validation result.
 */
export interface PendingValidation {
  toolName: string;
  filePath: string;
  timestamp: number;
  status: "pending" | "passed" | "failed";
  failureReason?: string;
  /** Hash of the last user message when validation was stored */
  userMessageHash?: string;
}

interface PendingValidationData {
  entries: PendingValidation[];
}

let cacheManager: CacheManager<PendingValidationData> | null = null;

/**
 * Initialize the pending validation cache for a session directory.
 * Call once per hook invocation after computing sessionDir.
 */
export function initValidationSession(sessionDir: string): void {
  cacheManager = new CacheManager<PendingValidationData>({
    filePath: path.join(sessionDir, "pending-validation.json"),
    defaultData: () => ({ entries: [] }),
    expiryMs: PENDING_VALIDATION_EXPIRY_MS,
    maxEntries: 1,
    getTimestamp: (e) => (e as PendingValidation).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as PendingValidation[] }),
  });
}

function getManager(): CacheManager<PendingValidationData> {
  if (!cacheManager) {
    throw new Error("pending-validation-cache: initValidationSession() must be called before use");
  }
  return cacheManager;
}

/**
 * Check if there's a failed validation from a previous tool call.
 * Returns the failed validation if one exists, hasn't expired, and is still relevant.
 * Expiry is handled automatically by CacheManager.
 *
 * @param currentUserMessageHash - Hash of the current last user message (optional)
 *        If provided and different from stored hash, validation is stale and skipped.
 * @returns The failed validation or null if none exists or is stale
 */
export async function checkPendingValidation(
  currentUserMessageHash?: string
): Promise<PendingValidation | null> {
  const data = await getManager().load();
  const validation = data.entries[0];
  if (!validation) return null;

  // Only return if failed (passed validations don't need action)
  if (validation.status !== "failed") {
    return null;
  }

  // Check if validation is stale (user sent a new message since validation was stored)
  if (
    currentUserMessageHash &&
    validation.userMessageHash &&
    currentUserMessageHash !== validation.userMessageHash
  ) {
    // User message changed - validation is stale, clear it
    await clearPendingValidation();
    return null;
  }

  return validation;
}

/**
 * Write a pending validation result to the cache.
 *
 * @param validation - The validation result to write
 */
export async function writePendingValidation(
  validation: Omit<PendingValidation, "timestamp">
): Promise<void> {
  const fullValidation: PendingValidation = {
    ...validation,
    timestamp: Date.now(),
  };

  await getManager().update(() => ({ entries: [fullValidation] }));
}

/**
 * Clear the pending validation cache.
 * Called after reporting a failure to the user or when user sends new message.
 */
export async function clearPendingValidation(): Promise<void> {
  await getManager().update(() => ({ entries: [] }));
}

/**
 * Check if there's any pending validation (including passed ones).
 * Useful for debugging and status checks.
 * Expiry is handled automatically by CacheManager.
 *
 * @returns The validation or null if none exists
 */
export async function getPendingValidationStatus(): Promise<PendingValidation | null> {
  const data = await getManager().load();
  return data.entries[0] ?? null;
}
