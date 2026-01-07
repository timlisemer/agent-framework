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

import { execSync } from "child_process";

/**
 * Push committed changes to the remote repository.
 *
 * @param workingDir - The project directory to push from
 * @returns Success message or error string
 */
export async function runPushAgent(workingDir: string): Promise<string> {
  try {
    const output = execSync("git push", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return output.trim() || "Pushed successfully";
  } catch (err) {
    return `ERROR: ${(err as Error).message}`;
  }
}
