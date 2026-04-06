/**
 * Hook process runner for the test harness.
 *
 * Spawns a hook as a child process, writes JSON to stdin, captures
 * stdout/stderr, enforces a timeout, and cleans up background processes.
 *
 * @module test-harness/lib/harness
 */

import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Result from running a hook process.
 */
export interface HookRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Spawn a hook process, pipe input JSON to stdin, capture output.
 *
 * Critical: stdin is closed immediately after writing to prevent
 * the 30s readStdinJson timeout in the hook process.
 */
export async function runHook(options: {
  hookScript: string;
  inputJson: string;
  env: Record<string, string>;
  timeoutMs: number;
}): Promise<HookRunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const child = spawn("node", [options.hookScript], {
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        stdout: stdout.trim(),
        stderr: err.message,
        exitCode: 1,
        timedOut: false,
      });
    });

    // Write input JSON to stdin and immediately close to prevent 30s hang
    child.stdin.write(options.inputJson);
    child.stdin.end();
  });
}

/**
 * Kill background processes spawned by hooks (e.g., summary-updater).
 * Hooks store PIDs in {sessionDir}/pids/ directory.
 */
export async function cleanupBackgroundProcesses(sessionDir: string): Promise<void> {
  const pidsDir = path.join(sessionDir, "pids");
  try {
    const entries = fs.readdirSync(pidsDir);
    for (const entry of entries) {
      try {
        const pid = parseInt(
          fs.readFileSync(path.join(pidsDir, entry), "utf-8").trim(),
          10
        );
        if (!isNaN(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
      } catch {
        // Skip unreadable PID files
      }
    }
  } catch {
    // No pids directory — nothing to clean up
  }

  // Small delay to let background processes settle
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * Clean up temp directory and session directory.
 */
export function cleanupTempFiles(tempDir: string, sessionDir: string): void {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
  try {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}
