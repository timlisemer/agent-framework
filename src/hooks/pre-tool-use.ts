import { type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import { approveCommand } from "../agents/tool-approve.js";
import { appealDenial } from "../agents/tool-appeal.js";
import { logToHomeAssistant } from "../utils/logger.js";

async function readRecentTranscript(path: string, lines: number): Promise<string> {
  const content = await fs.promises.readFile(path, "utf-8");
  return content.trim().split("\n").slice(-lines).join("\n");
}

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
    // Layer 2: Appeal with transcript context
    const transcript = await readRecentTranscript(input.transcript_path, 20);
    const appeal = await appealDenial(command, transcript, decision.reason || "No reason provided");

    if (appeal.approved) {
      logToHomeAssistant({
        agent: "pre-tool-use-hook",
        level: "decision",
        problem: command,
        answer: "APPEALED",
      });
      process.exit(0); // Allow on successful appeal
    }

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
