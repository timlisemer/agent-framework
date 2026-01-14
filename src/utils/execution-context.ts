/**
 * Execution Context - Process-scoped state tracking
 *
 * Tracks process-scoped state within a single Node.js process:
 * - Execution mode ("lazy" | "direct")
 * - Transcript path (for session-aware features like statusline)
 *
 * Since each hook runs as a separate process, this provides safe
 * isolation without cross-process state.
 *
 * Usage:
 * - Set mode at decision points (lazy fast-path, tool-approve lazy path)
 * - Set transcript path at hook entry points
 * - Logger functions read these automatically
 *
 * @module execution-context
 */

import { EXECUTION_MODES, type TelemetryMode } from "../types.js";

// Default to DIRECT - safer default, lazy must be explicitly set
let executionMode: TelemetryMode = EXECUTION_MODES.DIRECT;

// Transcript path for session-aware features
let currentTranscriptPath: string | undefined;

/**
 * Set the execution mode for the current process.
 *
 * Call this at decision points where the execution path is determined:
 * - pre-tool-use.ts fast-path: setExecutionMode(EXECUTION_MODES.LAZY)
 * - tool-approve.ts lazy path: setExecutionMode(EXECUTION_MODES.LAZY)
 *
 * @param mode - The execution mode ("lazy" or "direct")
 */
export function setExecutionMode(mode: TelemetryMode): void {
  executionMode = mode;
}

/**
 * Get the current execution mode.
 *
 * Called by logger functions to automatically determine the mode
 * for telemetry events.
 *
 * @returns The current execution mode (defaults to "direct")
 */
export function getExecutionMode(): TelemetryMode {
  return executionMode;
}

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
