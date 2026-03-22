/**
 * Shared background process spawner with PID-file deduplication.
 *
 * Centralizes the fork-detach-unref pattern used when launching fire-and-forget
 * child processes that should outlive the parent. When a dedupKey is provided,
 * only one instance per key can run at a time (checked via PID file).
 */

import { fork } from "child_process";
import * as fs from "fs";
import * as path from "path";

const STALE_PID_MS = 120_000;

interface SpawnOptions {
  dedupKey?: string;
  sessionDir?: string;
}

/**
 * Check if a process recorded in a PID file is still alive.
 * Removes stale PID files automatically.
 */
function isProcessAlive(pidFile: string): boolean {
  try {
    const raw = fs.readFileSync(pidFile, "utf-8");
    const data = JSON.parse(raw);
    const { pid, startedAt } = data;

    if (Date.now() - (startedAt ?? 0) > STALE_PID_MS) {
      try { fs.unlinkSync(pidFile); } catch {}
      return false;
    }

    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(pidFile); } catch {}
    return false;
  }
}

/**
 * Get the path to a PID file for a given dedup key.
 */
function getPidFilePath(sessionDir: string, dedupKey: string): string {
  return path.join(sessionDir, "pids", `${dedupKey}.pid`);
}

/**
 * Clean up the PID file for a background process on exit.
 * Call this from the spawned script before exiting.
 */
export function cleanupPidFile(sessionDir: string, dedupKey: string): void {
  try {
    fs.unlinkSync(getPidFilePath(sessionDir, dedupKey));
  } catch {}
}

/**
 * Spawn a detached background process and immediately unref it so the parent
 * can exit independently. When dedupKey and sessionDir are provided, ensures
 * only one instance per key runs at a time via PID file.
 *
 * On error, logs to stderr and returns without throwing (fail-open).
 *
 * @param scriptPath - Absolute path to the Node.js module to run.
 * @param args       - Command-line arguments forwarded to the child.
 * @param options    - Optional dedup key and session directory.
 */
export function spawnBackground(scriptPath: string, args: string[], options?: SpawnOptions): void {
  if (options?.dedupKey && options?.sessionDir) {
    const pidDir = path.join(options.sessionDir, "pids");
    const pidFile = getPidFilePath(options.sessionDir, options.dedupKey);

    if (isProcessAlive(pidFile)) {
      return;
    }

    try {
      fs.mkdirSync(pidDir, { recursive: true });
    } catch {}
  }

  try {
    const child = fork(scriptPath, args, { detached: true, stdio: "ignore", env: process.env });
    child.unref();

    if (options?.dedupKey && options?.sessionDir && child.pid) {
      const pidFile = getPidFilePath(options.sessionDir, options.dedupKey);
      fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() }));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`spawnBackground: failed to spawn ${scriptPath}: ${message}\n`);
  }
}
