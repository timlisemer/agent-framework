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
}

interface PendingValidationData {
  validation?: PendingValidation;
}

const cacheManager = new CacheManager<PendingValidationData>({
  filePath: "/tmp/claude-pending-validation.json",
  defaultData: () => ({}),
});

/**
 * Set the session for validation cache isolation.
 * Call this at the start of each hook invocation to ensure
 * subagent validations don't bleed into the main session.
 *
 * @param transcriptPath - Path to the transcript file (used as session ID)
 */
export function setValidationSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

/**
 * Check if there's a failed validation from a previous tool call.
 * Returns the failed validation if one exists and hasn't expired.
 *
 * @returns The failed validation or null if none exists
 */
export function checkPendingValidation(): PendingValidation | null {
  const data = cacheManager.load();
  if (!data.validation) return null;

  // Check expiry
  if (Date.now() - data.validation.timestamp > PENDING_VALIDATION_EXPIRY_MS) {
    clearPendingValidation();
    return null;
  }

  // Only return if failed (passed validations don't need action)
  if (data.validation.status === "failed") {
    return data.validation;
  }

  return null;
}

/**
 * Write a pending validation result to the cache.
 *
 * @param validation - The validation result to write
 */
export function writePendingValidation(
  validation: Omit<PendingValidation, "timestamp">
): void {
  const fullValidation: PendingValidation = {
    ...validation,
    timestamp: Date.now(),
  };

  cacheManager.update(() => ({ validation: fullValidation }));
}

/**
 * Clear the pending validation cache.
 * Called after reporting a failure to the user or when user sends new message.
 */
export function clearPendingValidation(): void {
  cacheManager.update(() => ({}));
}

/**
 * Check if there's any pending validation (including passed ones).
 * Useful for debugging and status checks.
 *
 * @returns The validation or null if none exists
 */
export function getPendingValidationStatus(): PendingValidation | null {
  const data = cacheManager.load();
  if (!data.validation) return null;

  // Check expiry
  if (Date.now() - data.validation.timestamp > PENDING_VALIDATION_EXPIRY_MS) {
    return null;
  }

  return data.validation;
}
