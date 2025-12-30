import { getModelId } from "../../types.js";
import { logToHomeAssistant } from "../../utils/logger.js";
import { runAgentQuery } from "../../utils/agent-query.js";
import { runCheckAgent } from "./check.js";

export async function runConfirmAgent(workingDir: string): Promise<string> {
  // Step 1: Run check agent first
  const checkResult = await runCheckAgent(workingDir);

  // Step 2: Parse check results for errors
  const errorMatch = checkResult.match(/Errors:\s*(\d+)/i);
  const errorCount = errorMatch ? parseInt(errorMatch[1], 10) : 0;
  const statusMatch = checkResult.match(/Status:\s*(PASS|FAIL)/i);
  const checkStatus = statusMatch ? statusMatch[1].toUpperCase() : "UNKNOWN";

  // Step 3: If check failed, decline immediately
  if (checkStatus === "FAIL" || errorCount > 0) {
    const result = `DECLINED: check failed with ${errorCount} error(s)`;
    logToHomeAssistant({
      agent: 'confirm',
      level: 'decision',
      problem: workingDir,
      answer: result,
    });
    return result;
  }

  // Step 4: Check passed, now analyze git diff
  const result = await runAgentQuery(
    'confirm',
    `Run \`git diff HEAD\` and evaluate the code changes. Return your verdict.`,
    {
      cwd: workingDir,
      model: getModelId("opus"),
      allowedTools: ["Bash"],
      systemPrompt: `You are a strict code quality gate. You have ONE job.

The code has already passed linting and type checks. Now evaluate the diff.

Run \`git diff HEAD\` to see uncommitted changes.

Evaluate against these criteria:
- No obvious bugs or logic errors
- No security vulnerabilities
- No hardcoded secrets or credentials
- No debug code (console.log, print, dbg!, etc.)
- Changes are coherent and intentional
- Reasonable code style

Then output EXACTLY one of:
CONFIRMED
or
DECLINED: <one sentence reason>

RULES:
- You CANNOT ask questions
- You CANNOT request more context
- You CANNOT suggest improvements
- You MUST decide based solely on the diff
- Small, obvious changes bias toward CONFIRMED
- Large, complex changes require higher scrutiny

This is a gate, not a review. Decide.`
    }
  );

  logToHomeAssistant({
    agent: 'confirm',
    level: 'decision',
    problem: workingDir,
    answer: result.output,
  });

  return result.output;
}
