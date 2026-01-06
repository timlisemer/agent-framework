import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const PENDING_VALIDATION_CACHE_FILE = "/tmp/claude-pending-validation.json";
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

/**
 * Check if there's a failed validation from a previous tool call.
 * Returns the failed validation if one exists and hasn't expired.
 *
 * @returns The failed validation or null if none exists
 */
export function checkPendingValidation(): PendingValidation | null {
  try {
    if (!fs.existsSync(PENDING_VALIDATION_CACHE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(PENDING_VALIDATION_CACHE_FILE, "utf-8");
    const validation: PendingValidation = JSON.parse(raw);

    // Check expiry
    if (Date.now() - validation.timestamp > PENDING_VALIDATION_EXPIRY_MS) {
      // Expired - clear and return null
      clearPendingValidation();
      return null;
    }

    // Only return if failed (passed validations don't need action)
    if (validation.status === "failed") {
      return validation;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Write a pending validation result to the cache.
 * Uses atomic write (temp file + rename) to avoid race conditions.
 *
 * @param validation - The validation result to write
 */
export function writePendingValidation(validation: Omit<PendingValidation, "timestamp">): void {
  const fullValidation: PendingValidation = {
    ...validation,
    timestamp: Date.now(),
  };

  try {
    // Atomic write: write to temp file, then rename
    const tempFile = path.join(os.tmpdir(), `claude-pending-validation-${process.pid}.tmp`);
    fs.writeFileSync(tempFile, JSON.stringify(fullValidation));
    fs.renameSync(tempFile, PENDING_VALIDATION_CACHE_FILE);
  } catch {
    // Ignore write errors - fail-open for performance
  }
}

/**
 * Clear the pending validation cache.
 * Called after reporting a failure to the user or when user sends new message.
 */
export function clearPendingValidation(): void {
  try {
    if (fs.existsSync(PENDING_VALIDATION_CACHE_FILE)) {
      fs.unlinkSync(PENDING_VALIDATION_CACHE_FILE);
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Check if there's any pending validation (including passed ones).
 * Useful for debugging and status checks.
 *
 * @returns The validation or null if none exists
 */
export function getPendingValidationStatus(): PendingValidation | null {
  try {
    if (!fs.existsSync(PENDING_VALIDATION_CACHE_FILE)) {
      return null;
    }

    const raw = fs.readFileSync(PENDING_VALIDATION_CACHE_FILE, "utf-8");
    const validation: PendingValidation = JSON.parse(raw);

    // Check expiry
    if (Date.now() - validation.timestamp > PENDING_VALIDATION_EXPIRY_MS) {
      return null;
    }

    return validation;
  } catch {
    return null;
  }
}
