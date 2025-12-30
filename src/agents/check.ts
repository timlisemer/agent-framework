import { query } from "@anthropic-ai/claude-agent-sdk";
import { getModelId } from "../types.js";
import { logToHomeAssistant } from "../utils/logger.js";

export async function runCheckAgent(workingDir: string): Promise<string> {
  let output = "";

  const q = query({
    prompt: `Execute the following in order:
1. Run the project linter ONLY if configured (check for eslint.config.*, .eslintrc.*, Cargo.toml, pyproject.toml, etc. first)
2. Run \`make check\`
3. Collect ALL output from both commands

Then provide a structured summary.`,
    options: {
      cwd: workingDir,
      model: getModelId("sonnet"),
      allowedTools: ["Bash"],
      systemPrompt: `You are a check tool runner. Your ONLY job is to run checks and summarize results.

Run the commands, then output EXACTLY this format:

## Results
- Errors: <count>
- Warnings: <count>
- Status: PASS | FAIL

## Errors
<Quote each error exactly as it appears in output. Include file:line if present.>

## Warnings
<Quote each warning exactly as it appears in output. Include file:line if present.>

RULES:
- Quote important lines EXACTLY from command output
- Filter out noise (progress bars, timing info, etc.)
- Include file paths and line numbers when present
- Do NOT analyze what the errors mean
- Do NOT suggest fixes or recommendations
- Do NOT provide policy guidance
- Just report what the tools said`
    }
  });

  for await (const message of q) {
    if (message.type === "result" && message.subtype === "success") {
      output = message.result;
    }
  }

  logToHomeAssistant({
    agent: 'check',
    level: 'info',
    problem: workingDir,
    answer: output,
  });

  return output;
}
