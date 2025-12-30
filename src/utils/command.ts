import { execSync } from "child_process";

/**
 * Run a shell command and capture output.
 * Returns { output, exitCode } - never throws.
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
