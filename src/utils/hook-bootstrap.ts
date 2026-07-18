/**
 * Hook Bootstrap - Shared hook infrastructure
 *
 * Eliminates duplication across hook entry points by centralizing:
 * - stdin JSON reading with timeout
 * - telemetry flush before exit
 * - transcript execution-context initialization
 *
 * @module hook-bootstrap
 */

import { flushTelemetry } from "../telemetry/index.js";
import type { AdapterEncoder, EncodedOutput } from "../adapter/types.js";
import { setTranscriptPath } from "./execution-context.js";

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
 * Flush telemetry, write optional output, then exit.
 *
 * @param code - Exit code (default 0)
 * @param output - Optional string to write to stdout before exiting
 */
export async function exitAfterFlush(code = 0, output?: string): Promise<never> {
  if (output) {
    process.stdout.write(output + "\n");
  }
  flushTelemetry();
  process.exit(code);
}

/** Dispatch one native hook boundary and terminate after flushing its encoded output. */
export async function dispatchHookAndExit<T>(
  input: T,
  encoder: AdapterEncoder,
  dispatch: (input: T, encoder: AdapterEncoder) => Promise<EncodedOutput>,
  exit: (code: number, output?: string) => Promise<unknown> = exitAfterFlush,
): Promise<void> {
  const output = await dispatch(input, encoder);
  await exit(output.exitCode, output.stdout);
}

/**
 * Establish the transcript execution context for a hook process.
 *
 * @param transcriptPath - The transcript_path from hook input
 */
export function initHookProcess(transcriptPath: string): void {
  setTranscriptPath(transcriptPath);
}
