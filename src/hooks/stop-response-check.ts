import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopResponseAlignment } from "../agents/hooks/response-align.js";
import { initRewindSession, detectRewind } from "../utils/rewind-cache.js";
import { setTranscriptPath } from "../utils/execution-context.js";
import { writeTool } from "../utils/synthetic.js";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir } from "../utils/summary-cache.js";
import { getUnconsumedCorrections, consumeCorrections } from "../utils/correction-cache.js";
import { getAllPredictions, isStopBlocked } from "../utils/prediction-cache.js";

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
  const input = await readStdinJson<StopHookInput>();

  // Set session and check for rewind
  setTranscriptPath(input.transcript_path);
  const sessionDir = getSessionDir(input.transcript_path);
  initRewindSession(sessionDir);
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
    await writeTool(input.transcript_path, input.session_id, "stop-hook", result.systemMessage);

    const output = JSON.stringify({
      decision: "block",
      reason: result.systemMessage,
    });
    exitAfterFlush(0, output);
    return;
  }

  // Check for unconsumed corrections from PostToolUse — only block if a prediction says stopping is wrong
  const corrections = await getUnconsumedCorrections(sessionDir);
  if (corrections.length > 0) {
    const predictions = await getAllPredictions(sessionDir);
    if (isStopBlocked(predictions)) {
      const messages = corrections
        .map((c) => `CORRECTION: ${c.toolName} (${c.toolTarget}) - ${c.reason}`)
        .join("\n");
      await consumeCorrections(sessionDir);
      await writeTool(input.transcript_path, input.session_id, "correction-check",
        `Actions need review:\n${messages}\nPlease address these issues.`);
      exitAfterFlush(0, JSON.stringify({ decision: "block", reason: messages }));
      return;
    }
    // No prediction blocks stopping — consume corrections silently
    await consumeCorrections(sessionDir);
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  exitAfterFlush(0);
});
