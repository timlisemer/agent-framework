import { evaluateBashPolicy } from "./bash-command-policy.js";
import { analyzeBashCommand } from "./bash-policy/analysis.js";

const PLAN_MODE_WRITE_COMMAND_HEADS: ReadonlySet<string> = new Set(["mkdir", "touch", "rm", "mv", "cp"]);

export function isPlanModeBashWrite(command: string, workingDir?: string): boolean {
  const result = evaluateBashPolicy(command, workingDir);
  if (result.terminal.riskClass === "high-risk-workaround") return false;
  if (result.terminal.ownerTopic === "file-write" || result.terminal.ownerTopic === "git" || result.terminal.ownerTopic === "script-exec" || result.terminal.ownerTopic === "run-install-remote" || result.terminal.ownerTopic === "find-sed") {
    return true;
  }
  if (result.terminal.commandHead && PLAN_MODE_WRITE_COMMAND_HEADS.has(result.terminal.commandHead)) {
    return true;
  }
  if (analyzeBashCommand(command).invocations.some((invocation) => PLAN_MODE_WRITE_COMMAND_HEADS.has(invocation.executable))) {
    return true;
  }
  return false;
}
