import { query } from "@anthropic-ai/claude-agent-sdk";
import { getModelId } from "../types.js";
import { logToHomeAssistant } from "../utils/logger.js";

export async function runConfirmAgent(workingDir: string): Promise<string> {
  let output = "";

  const q = query({
    prompt: `Run \`git diff HEAD\` and evaluate the code changes. Return your verdict.`,
    options: {
      cwd: workingDir,
      model: getModelId("opus"),
      allowedTools: ["Bash"],
      systemPrompt: `You are a strict code quality gate. You have ONE job.

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
  });

  for await (const message of q) {
    if (message.type === "result" && message.subtype === "success") {
      output = message.result;
    }
  }

  const result = output.trim();
  logToHomeAssistant({
    agent: 'confirm',
    level: 'decision',
    problem: workingDir,
    answer: result,
  });

  return result;
}
