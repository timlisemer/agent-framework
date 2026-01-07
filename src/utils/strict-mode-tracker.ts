import { CacheManager } from "./cache-manager.js";

const LARGE_EDIT_THRESHOLD = 20; // lines
const SESSION_START_STRICT_COUNT = 3; // first N tools always strict

interface StrictModeData {
  sessionToolCount: number;
  lastDenied: boolean;
  lastError: boolean;
}

const cacheManager = new CacheManager<StrictModeData>({
  filePath: "/tmp/claude-strict-mode.json",
  defaultData: () => ({ sessionToolCount: 0, lastDenied: false, lastError: false }),
});

/**
 * Set the session for strict mode tracking.
 * Call this at the start of each hook invocation.
 *
 * @param transcriptPath - Path to the transcript file (used as session ID)
 */
export function setStrictModeSession(transcriptPath: string): void {
  cacheManager.setSession(transcriptPath);
}

/**
 * Check if strict mode should be used based on current state.
 * Does NOT check first-response (use isFirstResponseChecked() separately).
 *
 * Rules checked:
 * 1. Session start - first N tools always strict
 * 2. After denial - one-shot, resets after next tool
 * 3. After error - one-shot, resets after next tool
 * 4. Large edits - Edit tool with >20 lines
 *
 * @param toolName - Name of the tool being called
 * @param toolInput - Input parameters for the tool
 * @returns Object with strict flag and optional reason
 */
export async function shouldUseStrictMode(
  toolName: string,
  toolInput: unknown
): Promise<{ strict: boolean; reason?: string }> {
  const data = await cacheManager.load();

  // Rule 1: Session start - first N tools always strict
  if (data.sessionToolCount < SESSION_START_STRICT_COUNT) {
    return { strict: true, reason: "session-start" };
  }

  // Rule 2: After denial - one-shot
  if (data.lastDenied) {
    return { strict: true, reason: "post-denial" };
  }

  // Rule 3: After error - one-shot
  if (data.lastError) {
    return { strict: true, reason: "post-error" };
  }

  // Rule 4: Large edits
  if (toolName === "Edit") {
    const input = toolInput as { old_string?: string; new_string?: string };
    const oldLines = (input.old_string || "").split("\n").length;
    const newLines = (input.new_string || "").split("\n").length;
    const lines = Math.max(oldLines, newLines);
    if (lines > LARGE_EDIT_THRESHOLD) {
      return { strict: true, reason: `large-edit-${lines}-lines` };
    }
  }

  return { strict: false };
}

/**
 * Record that a tool was denied.
 * Next tool call will use strict mode (one-shot).
 */
export async function recordDenial(): Promise<void> {
  await cacheManager.update((d) => ({ ...d, lastDenied: true }));
}

/**
 * Record that a tool had an error (e.g., async validation failure).
 * Next tool call will use strict mode (one-shot).
 */
export async function recordError(): Promise<void> {
  await cacheManager.update((d) => ({ ...d, lastError: true }));
}

/**
 * Increment the session tool count.
 * Call this after strict validation passes.
 */
export async function incrementToolCount(): Promise<void> {
  await cacheManager.update((d) => ({ ...d, sessionToolCount: d.sessionToolCount + 1 }));
}

/**
 * Clear one-shot flags (lastDenied, lastError).
 * Call this after strict validation completes.
 */
export async function clearOneShots(): Promise<void> {
  await cacheManager.update((d) => ({ ...d, lastDenied: false, lastError: false }));
}

/**
 * Get current strict mode data for debugging.
 */
export async function getStrictModeData(): Promise<StrictModeData> {
  return await cacheManager.load();
}
