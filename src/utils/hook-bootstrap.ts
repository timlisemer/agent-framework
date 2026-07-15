/**
 * Hook Bootstrap - Shared hook infrastructure
 *
 * Eliminates duplication across hook entry points by centralizing:
 * - stdin JSON reading with timeout
 * - telemetry and statusline flush before exit
 * - session initialization across all cache modules
 *
 * @module hook-bootstrap
 */

import { flushTelemetry } from "../telemetry/index.js";
import { flushStatuslineUpdates } from "./logger.js";
import { setTranscriptPath } from "./execution-context.js";
import { getAgentFrameworkSessionDir } from "./paths.js";
import { initStatuslineSession } from "./statusline-state.js";
import { initEpochSession } from "../scenario/epoch.js";

/**
 * Read and parse JSON from stdin with an optional timeout.
 *
 * Resolves with the parsed value when stdin closes, or rejects if
 * the timeout expires or parsing fails.
 *
 * @param timeoutMs - Milliseconds before rejecting (default 30000)
 * @returns Parsed JSON value typed as T
 */
export function readStdinJson<T>(timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => reject(new Error("stdin timeout")), timeoutMs);
    const onData = (chunk: Buffer | string) => (data += chunk);
    const onEnd = () => {
      clearTimeout(timeout);
      process.stdin.removeListener("data", onData);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
  });
}

/**
 * Flush telemetry and statusline updates, write optional output, then exit.
 *
 * Uses Promise.race with a 200ms fallback so the process always exits
 * even if the statusline flush hangs.
 *
 * @param code - Exit code (default 0)
 * @param output - Optional string to write to stdout before exiting
 */
export async function exitAfterFlush(code = 0, output?: string): Promise<never> {
  if (output) {
    process.stdout.write(output + "\n");
  }
  flushTelemetry();
  await Promise.race([
    flushStatuslineUpdates(),
    new Promise((r) => setTimeout(r, 200)),
  ]);
  process.exit(code);
}

/**
 * Initialize all session-scoped caches for a hook process.
 *
 * Call this once at the top of each hook's main function after reading
 * the transcript path from hook input. Computes the session directory
 * and initializes all caches to use files within it.
 *
 * @param transcriptPath - The transcript_path from hook input
 */
export function initHookProcess(transcriptPath: string): void {
  setTranscriptPath(transcriptPath);
  const sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
  initStatuslineSession(sessionDir);
  initEpochSession(sessionDir);
}
