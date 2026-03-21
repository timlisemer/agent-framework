import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as path from "path";
import { fileURLToPath } from "url";
import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { checkStopResponseAlignment } from "../agents/hooks/response-align.js";
import { setRewindSession, detectRewind } from "../utils/rewind-cache.js";
import { setTranscriptPath } from "../utils/execution-context.js";
import { appendSyntheticToolResult } from "../utils/transcript-writer.js";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, appendToolLog, getActiveSubagentCount } from "../utils/summary-cache.js";
import { spawnBackground } from "../utils/spawn-background.js";
import { isSubagent } from "../utils/subagent-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
    // Append synthetic entry to transcript so agents can see this feedback
    await appendSyntheticToolResult(input.transcript_path, "Stop", result.systemMessage);

    // Log synthetic message to tool log and trigger summary update
    if (!isSubagent(input.transcript_path)) {
      const sessionDir = getSessionDir(input.transcript_path);
      appendToolLog(sessionDir, {
        ts: Date.now(),
        tool: "SyntheticMessage",
        status: "allowed",
        gate: "stop-hook",
        reason: result.reason,
        ms: 0,
      });
      const activeSubagents = getActiveSubagentCount(sessionDir);
      if (activeSubagents === 0) {
        const updaterPath = path.join(__dirname, "../utils/summary-updater.js");
        spawnBackground(updaterPath, [
          "--mode", "actions",
          "--transcript", input.transcript_path,
          "--session-id", input.session_id,
        ]);
      }
    }

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
