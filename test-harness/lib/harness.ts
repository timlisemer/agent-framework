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
 * Wait for background updater processes (e.g., summary-updater) to finish
 * writing before SIGTERM-ing them. Required so `prediction-cache.json` and
 * other cache writes complete cleanly. Polls every 250ms and returns when
 * all PID files report dead processes OR `timeoutMs` elapses.
 *
 * Drains ALL pid files (not just summary-updater-*) — future-proof against
 * new background spawners. Default ceiling 120000ms matches STALE_PID_MS in
 * src/utils/spawn-background.ts (twice the summary-updater 60s hard timeout,
 * with slack for flushTelemetry + final savePrediction).
 */
export async function drainBackgroundUpdaters(
  sessionDir: string,
  timeoutMs: number = 120_000,
): Promise<void> {
  const pidsDir = path.join(sessionDir, "pids");
  const deadline = Date.now() + timeoutMs;
  const pollIntervalMs = 250;

  function readPidFiles(): Array<{ pid: number; file: string }> {
    let entries: string[];
    try {
      entries = fs.readdirSync(pidsDir);
    } catch {
      return [];
    }
    const out: Array<{ pid: number; file: string }> = [];
    for (const entry of entries) {
      if (!entry.endsWith(".pid")) continue;
      const file = path.join(pidsDir, entry);
      try {
        const raw = fs.readFileSync(file, "utf-8").trim();
        let pid: number;
        try {
          const parsed = JSON.parse(raw);
          pid = parsed.pid;
        } catch {
          pid = parseInt(raw, 10);
        }
        if (!isNaN(pid)) {
          out.push({ pid, file });
        }
      } catch {
        // Unreadable PID file — skip
      }
    }
    return out;
  }

  while (Date.now() < deadline) {
    const pidEntries = readPidFiles();
    if (pidEntries.length === 0) return;
    const stillAlive = pidEntries.filter(({ pid }) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (stillAlive.length === 0) return;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  process.stderr.write(
    `drainBackgroundUpdaters: timeout after ${timeoutMs}ms in ${sessionDir}\n`,
  );
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
        const raw = fs.readFileSync(path.join(pidsDir, entry), "utf-8").trim();
        let pid: number;
        try {
          const parsed = JSON.parse(raw);
          pid = parsed.pid;
        } catch {
          pid = parseInt(raw, 10);
        }
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

