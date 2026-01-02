import "../utils/load-env.js";
import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkFirstResponseIntentForStop } from "../agents/hooks/first-response-intent.js";
import { logToHomeAssistant } from "../utils/logger.js";

/**
 * Stop Hook: First Response Intent Check
 *
 * This hook runs when the AI stops (text-only response, no tool calls).
 * It detects when the AI:
 * - Uses plain text questions instead of AskUserQuestion tool
 * - Asks for plan approval in text instead of ExitPlanMode tool
 * - Doesn't answer the user's question
 * - Stops without clear reason
 *
 * If detected, it injects a system message to course-correct the AI.
 */

async function main() {
  const input: StopHookInput = await new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(JSON.parse(data)));
  });

  const result = await checkFirstResponseIntentForStop(input.transcript_path);

  if (!result.approved && result.systemMessage) {
    logToHomeAssistant({
      agent: "stop-first-response",
      level: "decision",
      problem: result.reason || "Stop check failed",
      answer: result.systemMessage.slice(0, 100),
    });

    console.log(
      JSON.stringify({
        continue: true,
        systemMessage: result.systemMessage,
      })
    );
    process.exit(0);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
