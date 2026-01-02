/**
 * Push Agent - Git Push to Remote
 *
 * This agent pushes committed changes to the remote repository.
 * Unlike other agents, it does NOT run through the confirm/check chain
 * since pushing is a simple, non-destructive (locally) operation.
 *
 * ## FLOW
 *
 * 1. Execute git push
 * 2. Return success message or error
 *
 * ## USAGE
 *
 * This agent is typically called after commit agent succeeds.
 * It can be invoked via the MCP tool or through /push skill.
 *
 * @module push
 */

import { execSync } from "child_process";
import { logToHomeAssistant } from "../../utils/logger.js";

/**
 * Push committed changes to the remote repository.
 *
 * @param workingDir - The project directory to push from
 * @returns Success message or error string
 *
 * @example
 * ```typescript
 * const result = await runPushAgent('/path/to/project');
 * if (!result.startsWith('ERROR:')) {
 *   // Push successful
 * }
 * ```
 */
export async function runPushAgent(workingDir: string): Promise<string> {
  try {
    const output = execSync("git push", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const result = output.trim() || "Pushed successfully";
    logToHomeAssistant({ agent: 'push', level: 'info', problem: workingDir, answer: result });
    return result;
  } catch (err) {
    const error = `ERROR: ${(err as Error).message}`;
    logToHomeAssistant({ agent: 'push', level: 'error', problem: workingDir, answer: error });
    return error;
  }
}
