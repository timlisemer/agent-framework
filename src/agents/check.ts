import { query } from "@anthropic-ai/claude-agent-sdk";
import { getModelId } from "../types.js";
import { logToHomeAssistant } from "../utils/logger.js";

export async function runCheckAgent(workingDir: string): Promise<string> {
  let output = "";

  const q = query({
    prompt: `Execute the following in order:
1. Run the project linter (detect from project type - eslint, clippy, ruff, etc.)
2. Run \`make check\`
3. Collect ALL output from both commands

Then provide a structured summary.`,
    options: {
      cwd: workingDir,
      model: getModelId("sonnet"),
      allowedTools: ["Bash"],
      systemPrompt: `You are a code quality analyzer. You can ONLY run linting and make check commands.

After running the commands, provide:

## Summary
- Total errors: X
- Total warnings: Y
- Commands executed: [list]

## Errors (if any)
Cite exact lines from output. No recommendations for errors.

## Warnings with Recommendations
For each warning, cite the exact output line, then provide a policy recommendation:
- Unused variables: "Acceptable if marked with #[allow(unused)] or // ALLOW_UNUSED"
- Unused imports: "Remove unless needed for side effects"
- Deprecation warnings: "Track for future migration, not blocking"
- Style warnings: "Fix in dedicated cleanup PR"

You have NO access to source code. You can only see command output.
Do NOT suggest code fixes. Only provide policy recommendations.`
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
