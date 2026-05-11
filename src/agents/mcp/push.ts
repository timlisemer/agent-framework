/**
 * Push Agent - Git Push to Remote
 *
 * This agent pushes committed changes to the remote repository.
 * Unlike other agents, it does NOT run through the confirm/check chain
 * since pushing is a simple, non-destructive (locally) operation.
 *
 * Note: No telemetry logging - this is a simple git command wrapper, not an LLM agent.
 *
 * @module push
 */

import { runProcessCancellable } from "../../utils/command.js";
import { isCancellationError, type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";

/**
 * Push committed changes to the remote repository.
 *
 * @param workingDir - The project directory to push from
 * @returns Success message or error string
 */
export async function runPushAgent(
  workingDir: string,
  options: CancellationOptions = {}
): Promise<string> {
  try {
    throwIfAborted(options.signal);
    const result = await runProcessCancellable(
      { shell: false, file: "git", args: ["push"] },
      workingDir,
      options
    );
    if (result.exitCode !== 0) {
      return `ERROR: ${result.output}`;
    }
    return result.output.trim() || "Pushed successfully";
  } catch (err) {
    if (isCancellationError(err)) {
      throw err;
    }
    return `ERROR: ${(err as Error).message}`;
  }
}
