import "../utils/load-env.js";
import { initializeTelemetry, flushTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopResponseAlignment } from "../agents/hooks/response-align.js";
import {
  setRewindSession,
  detectRewind,
} from "../utils/rewind-cache.js";
import { setTranscriptPath } from "../utils/execution-context.js";
import { flushStatuslineUpdates } from "../utils/logger.js";

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

/**
 * Exit process after flushing telemetry and statusline updates.
 * Uses process.stdout.write with callback to ensure any output is flushed
 * before process.exit() - prevents lost output when stdout is piped.
 *
 * @param code - Exit code (default 0)
 * @param output - Optional output to write before exiting
 */
function exitAfterFlush(code = 0, output?: string): void {
  // Outer fallback in case write callback never fires
  setTimeout(() => process.exit(code), 200);

  const doExit = () => {
    flushTelemetry();
    flushStatuslineUpdates().finally(() => process.exit(code));
    setTimeout(() => process.exit(code), 100);
  };

  if (output) {
    process.stdout.write(output + "\n", doExit);
  } else {
    doExit();
  }
}

async function main() {
  const input: StopHookInput = await new Promise((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(() => reject(new Error("stdin timeout")), 30000);
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => {
      clearTimeout(timeout);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
  });

  // Set session and check for rewind
  setRewindSession(input.transcript_path);
  setTranscriptPath(input.transcript_path);
  const rewound = await detectRewind(input.transcript_path);

  if (rewound) {
    // After rewind, don't inject errors - let AI continue fresh
    exitAfterFlush(0);
    return;
  }

  const result = await checkStopResponseAlignment(
    input.transcript_path,
    process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    "Stop"
  );

  if (!result.approved && result.systemMessage) {
    const output = JSON.stringify({
      decision: "block",
      reason: result.systemMessage,
    });
    exitAfterFlush(0, output);
    return;
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  exitAfterFlush(0);
});
