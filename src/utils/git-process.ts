import {
  runProcessCancellable,
  type ProcessOutputLimits,
  type ProcessResult,
} from "./command.js";

export function runGitCancellable(
  args: string[],
  cwd: string,
  options: ProcessOutputLimits = {},
): Promise<ProcessResult> {
  return runProcessCancellable({ shell: false, file: "git", args }, cwd, options);
}
