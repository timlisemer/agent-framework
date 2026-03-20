/**
 * Execution Context - Process-scoped state tracking
 *
 * Tracks process-scoped state within a single Node.js process:
 * - Transcript path (for session-aware features like statusline)
 *
 * Since each hook runs as a separate process, this provides safe
 * isolation without cross-process state.
 *
 * Usage:
 * - Set transcript path at hook entry points
 * - Logger functions read these automatically
 *
 * @module execution-context
 */

// Transcript path for session-aware features
let currentTranscriptPath: string | undefined;

/**
 * Set the transcript path for the current process.
 *
 * Call this at hook entry points where transcript_path is available.
 * Used by session-aware features like statusline state.
 *
 * @param path - The transcript path from hook input
 */
export function setTranscriptPath(path: string): void {
  currentTranscriptPath = path;
}

/**
 * Get the current transcript path.
 *
 * Called by logger to pass session context to statusline state.
 *
 * @returns The transcript path, or undefined if not set
 */
export function getTranscriptPath(): string | undefined {
  return currentTranscriptPath;
}
