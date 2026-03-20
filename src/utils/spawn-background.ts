/**
 * Shared background process spawner.
 *
 * Centralizes the fork-detach-unref pattern used when launching fire-and-forget
 * child processes that should outlive the parent. Callers are responsible for
 * any cache or state updates on failure; this module is fail-open by design.
 */

import { fork } from "child_process";

/**
 * Spawn a detached background process and immediately unref it so the parent
 * can exit independently. On error, logs to stderr and returns without
 * throwing (fail-open).
 *
 * @param scriptPath - Absolute path to the Node.js module to run.
 * @param args       - Command-line arguments forwarded to the child.
 */
export function spawnBackground(scriptPath: string, args: string[]): void {
  try {
    const child = fork(scriptPath, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`spawnBackground: failed to spawn ${scriptPath}: ${message}\n`);
  }
}
