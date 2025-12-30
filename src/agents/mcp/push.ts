import { execSync } from "child_process";
import { logToHomeAssistant } from "../../utils/logger.js";

export async function runPushAgent(workingDir: string): Promise<string> {
  try {
    const output = execSync("git push", {
      cwd: workingDir,
      encoding: "utf-8",
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const result = output.trim() || "Pushed successfully";
    logToHomeAssistant({ agent: 'push', level: 'info', problem: workingDir, answer: result });
    return result;
  } catch (err) {
    const error = `ERROR: ${(err as Error).message}`;
    logToHomeAssistant({ agent: 'push', level: 'error', problem: workingDir, answer: error });
    return error;
  }
}
