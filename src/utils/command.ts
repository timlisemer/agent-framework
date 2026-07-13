import { execSync, spawn } from "child_process";
import { OperationCancelledError, type CancellationOptions, throwIfAborted } from "./cancellation.js";
import { utf8BufferHead, utf8BufferTail } from "./text-bounds.js";

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
  commandTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  preserveTailOnTruncate?: boolean;
}

export interface ProcessResult {
  output: string;
  exitCode: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutInvalidUtf8: boolean;
  stderrInvalidUtf8: boolean;
  timedOut?: boolean;
  timeoutMs?: number;
}

const DEFAULT_PROCESS_STREAM_LIMIT_BYTES = 2 * 1024 * 1024;
const TIMED_OUT_EXIT_CODE = 124;

type BoundedOutputCapture = {
  value: Buffer;
  totalBytes: number;
  head: Buffer;
  tail: Buffer;
  truncated: boolean;
};

function createBoundedOutputCapture(): BoundedOutputCapture {
  return {
    value: Buffer.alloc(0),
    totalBytes: 0,
    head: Buffer.alloc(0),
    tail: Buffer.alloc(0),
    truncated: false,
  };
}

function formatStreamTruncationMarker(
  streamName: "stdout" | "stderr",
  limit: number,
): string {
  return `\n[agent-framework: ${streamName} truncated after ${limit} bytes]\n`;
}

export function formatCommandTimeoutDuration(timeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const unit = seconds === 1 ? "second" : "seconds";
  return `${seconds} ${unit}`;
}

function appendTailPreservingOutput(
  capture: BoundedOutputCapture,
  chunk: Buffer,
  limit: number,
): void {
  if (limit <= 0) {
    capture.totalBytes += chunk.length;
    capture.truncated ||= chunk.length > 0;
    return;
  }

  const headLimit = Math.floor(limit / 2);
  const tailLimit = limit - headLimit;
  const previousTotal = capture.totalBytes;
  capture.totalBytes += chunk.length;

  if (previousTotal < headLimit) {
    const headRemaining = headLimit - previousTotal;
    capture.head = Buffer.concat([
      capture.head,
      chunk.subarray(0, headRemaining),
    ]);
  }

  if (tailLimit > 0) {
    const nextTail = Buffer.concat([capture.tail, chunk]);
    capture.tail = nextTail.subarray(Math.max(0, nextTail.length - tailLimit));
  }

  if (capture.totalBytes <= limit) {
    capture.value = Buffer.concat([capture.value, chunk]);
  } else {
    capture.truncated = true;
  }
}

function appendBoundedOutput(
  capture: BoundedOutputCapture,
  data: Buffer | string,
  limit: number,
  streamName: "stdout" | "stderr",
  preserveTailOnTruncate: boolean,
): void {
  const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (preserveTailOnTruncate) {
    appendTailPreservingOutput(capture, chunk, limit);
    return;
  }

  const used = capture.value.length;
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) {
    capture.truncated ||= chunk.length > 0;
    return;
  }

  if (chunk.length <= remaining) {
    capture.value = Buffer.concat([capture.value, chunk]);
    return;
  }

  const marker = formatStreamTruncationMarker(streamName, limit);
  const completePrefix = Buffer.concat([
    capture.value,
    chunk.subarray(0, remaining),
  ]);
  capture.value = Buffer.concat([
    utf8BufferHead(completePrefix, limit),
    Buffer.from(marker, "utf8"),
  ]);
  capture.truncated = true;
}

function formatBoundedOutput(
  capture: BoundedOutputCapture,
  limit: number,
  streamName: "stdout" | "stderr",
  preserveTailOnTruncate: boolean,
): string {
  if (!capture.truncated) {
    return capture.value.toString("utf-8");
  }
  if (!preserveTailOnTruncate) {
    return utf8BufferHead(capture.value, capture.value.length).toString("utf-8");
  }

  const marker = formatStreamTruncationMarker(streamName, limit);
  return utf8BufferHead(capture.head, capture.head.length).toString("utf-8") +
    marker +
    utf8BufferTail(capture.tail, capture.tail.length).toString("utf-8");
}

function captureHasInvalidUtf8(
  capture: BoundedOutputCapture,
  preserveTailOnTruncate: boolean,
): boolean {
  const buffers = !capture.truncated
    ? [capture.value]
    : preserveTailOnTruncate
    ? [utf8BufferHead(capture.head, capture.head.length), utf8BufferTail(capture.tail, capture.tail.length)]
    : [utf8BufferHead(capture.value, capture.value.length)];
  return buffers.some((buffer) => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      return false;
    } catch {
      return true;
    }
  });
}

function formatCommandTimeoutMarker(timeoutMs: number): string {
  return `\n[agent-framework: command timed out after ${formatCommandTimeoutDuration(timeoutMs)}; process terminated]\n`;
}

export async function runProcessCancellable(
  mode: ProcessMode,
  cwd: string,
  options: ProcessOutputLimits = {}
): Promise<ProcessResult> {
  throwIfAborted(options.signal);

  return new Promise((resolve, reject) => {
    let settled = false;
    let closed = false;
    let timedOut = false;
    const stdout = createBoundedOutputCapture();
    const stderr = createBoundedOutputCapture();
    const maxStdoutBytes = options.maxStdoutBytes ?? DEFAULT_PROCESS_STREAM_LIMIT_BYTES;
    const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_PROCESS_STREAM_LIMIT_BYTES;
    const preserveTailOnTruncate = options.preserveTailOnTruncate ?? false;
    let commandTimeout: ReturnType<typeof setTimeout> | undefined;

    const child = mode.shell
      ? spawn(mode.command, {
          cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          shell: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn(mode.file, mode.args, {
          cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });

    const cleanup = () => {
      options.signal?.removeEventListener("abort", onAbort);
      if (commandTimeout) {
        clearTimeout(commandTimeout);
        commandTimeout = undefined;
      }
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
    if (options.commandTimeoutMs !== undefined) {
      commandTimeout = setTimeout(() => {
        if (settled || closed) {
          return;
        }
        timedOut = true;
        terminate();
      }, options.commandTimeoutMs);
      commandTimeout.unref?.();
    }

    child.stdout?.on("data", (data: Buffer | string) => {
      if (stdout.truncated && !preserveTailOnTruncate) return;
      appendBoundedOutput(stdout, data, maxStdoutBytes, "stdout", preserveTailOnTruncate);
    });
    child.stderr?.on("data", (data: Buffer | string) => {
      if (stderr.truncated && !preserveTailOnTruncate) return;
      appendBoundedOutput(stderr, data, maxStderrBytes, "stderr", preserveTailOnTruncate);
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
      const output =
        formatBoundedOutput(stdout, maxStdoutBytes, "stdout", preserveTailOnTruncate) +
        formatBoundedOutput(stderr, maxStderrBytes, "stderr", preserveTailOnTruncate) +
        (timedOut && options.commandTimeoutMs !== undefined
          ? formatCommandTimeoutMarker(options.commandTimeoutMs)
          : "");
      resolve({
        output,
        exitCode: timedOut ? TIMED_OUT_EXIT_CODE : code ?? 1,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        stdoutInvalidUtf8: captureHasInvalidUtf8(stdout, preserveTailOnTruncate),
        stderrInvalidUtf8: captureHasInvalidUtf8(stderr, preserveTailOnTruncate),
        ...(timedOut ? { timedOut: true, timeoutMs: options.commandTimeoutMs } : {}),
      });
    });
  });
}
