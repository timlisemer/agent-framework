import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopIntentAlignment } from "../agents/hooks/intent-align.js";
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
    // After rewind, don't inject errors - let AI continue fresh
    process.exit(0);
  }

  const result = await checkStopIntentAlignment(
    input.transcript_path,
    process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    "Stop"
  );

  if (!result.approved && result.systemMessage) {
    console.log(
      JSON.stringify({
        decision: "block",
        reason: result.systemMessage,
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
