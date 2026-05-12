import { execSync, spawn } from "child_process";
import { OperationCancelledError, type CancellationOptions, throwIfAborted } from "./cancellation.js";

/**
 * Run a shell command and capture output.
 * Returns { output, exitCode } - never throws.
 *
 * ## IMPORTANT: Non-Cancellable Execution
 *
 * This function uses `execSync()` which is BLOCKING and NON-CANCELLABLE.
 * Once a command starts executing, it WILL complete before this function returns.
 * There is no way to abort a running command mid-execution.
 *
 * ### Implications for Git Operations
 *
 * When used for git commands (e.g., `git commit`, `git push`), this creates
 * a race condition where user interruption cannot prevent the operation:
 *
 * ```
 * Timeline:
 * 1. MCP tool calls runCommand("git commit ...")
 * 2. execSync() starts, git commit begins executing
 * 3. User clicks interrupt / sends abort signal
 * 4. Git commit COMPLETES (already running, cannot be stopped)
 * 5. execSync() returns to runCommand()
 * 6. MCP tool response is aborted (AbortError)
 * 7. User sees "aborted" but commit is already on disk
 * ```
 *
 * ### Why This Matters
 *
 * - The pre-tool-use hook can only block BEFORE runCommand() is called
 * - Once inside execSync(), no hooks or signals can stop the command
 * - User sees AbortError but the git operation completed successfully
 * - This can lead to commits/pushes that the user thought were cancelled
 *
 * ### Future Improvement
 *
 * To properly support cancellation, consider:
 * - Using `spawn()` with signal handling (SIGTERM/SIGINT)
 * - Implementing a transactional pattern (create temp branch, verify, merge)
 * - Adding a confirmation step BEFORE running irreversible operations
 * - Using an AbortController pattern for cancellation tokens
 *
 * For now, the mitigation is to ensure hooks block BEFORE this function
 * is called, rather than trying to abort during execution.
 */
export function runCommand(cmd: string, cwd: string): { output: string; exitCode: number } {
  try {
    const output = execSync(cmd, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
    return { output, exitCode: 0 };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; status?: number };
    const output = (error.stdout || "") + (error.stderr || "");
    return { output, exitCode: error.status ?? 1 };
  }
}

export type ProcessMode =
  | { shell: true; command: string }
  | { shell: false; file: string; args: string[] };

export interface ProcessOutputLimits extends CancellationOptions {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

const DEFAULT_PROCESS_STREAM_LIMIT_BYTES = 2 * 1024 * 1024;

function appendBoundedOutput(
  current: string,
  data: Buffer | string,
  limit: number,
  streamName: "stdout" | "stderr",
): { value: string; truncated: boolean } {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const used = Buffer.byteLength(current, "utf-8");
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) {
    return { value: current, truncated: chunk.length > 0 };
  }

  if (chunk.length <= remaining) {
    return { value: current + chunk.toString("utf-8"), truncated: false };
  }

  const marker = `\n[agent-framework: ${streamName} truncated after ${limit} bytes]\n`;
  return {
    value: current + chunk.subarray(0, remaining).toString("utf-8") + marker,
    truncated: true,
  };
}

export async function runProcessCancellable(
  mode: ProcessMode,
  cwd: string,
  options: ProcessOutputLimits = {}
): Promise<{ output: string; exitCode: number }> {
  throwIfAborted(options.signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_PROCESS_STREAM_LIMIT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_PROCESS_STREAM_LIMIT_BYTES;

    const child = mode.shell
      ? spawn(mode.command, {
          cwd,
          shell: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(mode.file, mode.args, {
          cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
    };

    const terminate = () => {
      if (child.pid === undefined) {
        return;
      }

      if (process.platform === "win32") {
        child.kill("SIGTERM");
        return;
      }

      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }

      setTimeout(() => {
        if (closed) {
          return;
        }
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }, 1000).unref();
    };

    const onAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      terminate();
      cleanup();
      reject(new OperationCancelledError());
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (data: Buffer | string) => {
      if (stdoutTruncated) return;
      const next = appendBoundedOutput(stdout, data, maxStdoutBytes, "stdout");
      stdout = next.value;
      stdoutTruncated = next.truncated;
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      if (stderrTruncated) return;
      const next = appendBoundedOutput(stderr, data, maxStderrBytes, "stderr");
      stderr = next.value;
      stderrTruncated = next.truncated;
    });

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    });

    child.on("close", (code) => {
      closed = true;
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ output: stdout + stderr, exitCode: code ?? 1 });
    });
  });
}
