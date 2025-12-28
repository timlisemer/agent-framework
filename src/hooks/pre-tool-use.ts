import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { approveCommand } from "../agents/tool-approve.js";
import { logToHomeAssistant } from "../utils/logger.js";

async function main() {
  const input: PreToolUseHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  // Only intercept Bash commands
  if (input.tool_name !== "Bash") {
    process.exit(0); // Allow non-bash tools
  }

  const command = (input.tool_input as { command: string }).command;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  const decision = await approveCommand(command, projectDir);

  logToHomeAssistant({
    agent: 'pre-tool-use-hook',
    level: 'decision',
    problem: command,
    answer: decision.approved ? 'ALLOWED' : `DENIED: ${decision.reason}`,
  });

  if (!decision.approved) {
    // Output structured JSON to deny and provide feedback to Claude
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: decision.reason
      }
    }));
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
