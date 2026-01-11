import { execSync } from "child_process";

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
