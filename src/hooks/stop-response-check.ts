import "../utils/load-env.js";
import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopIntentAlignment } from "../agents/hooks/intent-align.js";
import { logToHomeAssistant } from "../utils/logger.js";
import {
  setRewindSession,
  detectRewind,
} from "../utils/rewind-cache.js";

/**
 * Stop Hook: Response Check
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

  // Set session and check for rewind
  setRewindSession(input.transcript_path);
  const rewound = await detectRewind(input.transcript_path);

  if (rewound) {
    logToHomeAssistant({
      agent: "stop-response-check",
      level: "info",
      problem: "Rewind detected",
      answer: "Cleared caches, skipping stop check",
    });
    // After rewind, don't inject errors - let AI continue fresh
    process.exit(0);
  }

  const result = await checkStopIntentAlignment(input.transcript_path);

  if (!result.approved && result.systemMessage) {
    logToHomeAssistant({
      agent: "stop-response-check",
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
