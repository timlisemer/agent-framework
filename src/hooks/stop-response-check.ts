import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopResponseAlignment } from "../agents/hooks/response-align.js";
import { initRewindSession, detectRewind } from "../utils/rewind-cache.js";
import { setTranscriptPath } from "../utils/execution-context.js";
import { writeTool } from "../utils/synthetic.js";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { withSessionLock } from "../utils/session-mutex.js";
import { isPlanModeActive, isPlanModeFromInput } from "../utils/plan-mode-detector.js";

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

  const planMode = input.permission_mode !== undefined
    ? isPlanModeFromInput(input)
    : isPlanModeActive(input.transcript_path);

  const state = await getSessionState(sessionDir).load();
  const result = await checkStopResponseAlignment(
    input.transcript_path,
    process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    "Stop",
    planMode,
    state.currentPrediction,
    state.frustrationStreak ?? 0,
  );

  if (!result.approved && result.systemMessage) {
    await withSessionLock(sessionDir, async () => {
      await writeTool(input.transcript_path, input.session_id, "stop-hook", result.systemMessage!);
    });

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
