/**
 * Hook process runner for the test harness.
 *
 * Spawns a hook as a child process, writes JSON to stdin, captures
 * stdout/stderr, and enforces a timeout.
 *
 * @module test-harness/lib/harness
 */

import { spawn } from "child_process";

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
