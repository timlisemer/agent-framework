import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { validateIntent } from "../agents/intent-validate.js";
import { logToHomeAssistant } from "../utils/logger.js";

async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  // Only validate Edit, Write, and Bash tools
  if (!['Edit', 'Write', 'Bash'].includes(input.tool_name)) {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const result = await validateIntent(
    {
      type: 'tool_use',
      toolName: input.tool_name,
      toolInput: input.tool_input
    },
    input.transcript_path,
    projectDir
  );

  logToHomeAssistant({
    agent: 'intent-validation-pre-tool',
    level: 'decision',
    problem: `${input.tool_name}: ${JSON.stringify(input.tool_input).substring(0, 100)}`,
    answer: result.decision + (result.reason ? `: ${result.reason}` : '')
  });

  if (result.decision === 'BLOCK') {
    // Critical misalignment - deny the tool use
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `Intent Validation: ${result.reason}`
      }
    }));
  }

  // WARN and ALLOW both exit 0 (allow execution)
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
