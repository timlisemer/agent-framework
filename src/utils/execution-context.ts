/**
 * Execution Context - Process-scoped mode tracking
 *
 * Tracks the current execution mode ("lazy" | "direct") within a single
 * Node.js process. Since each hook runs as a separate process, this
 * provides safe isolation without cross-process state.
 *
 * Usage:
 * - Set mode at decision points (lazy fast-path, tool-approve lazy path)
 * - Logger functions read mode automatically via getExecutionMode()
 * - Default is DIRECT - lazy must be explicitly set
 *
 * @module execution-context
 */

import { EXECUTION_MODES, type TelemetryMode } from "../types.js";

// Default to DIRECT - safer default, lazy must be explicitly set
let executionMode: TelemetryMode = EXECUTION_MODES.DIRECT;

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
