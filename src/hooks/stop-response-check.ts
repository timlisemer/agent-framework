import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { type StopHookInput } from "@anthropic-ai/claude-agent-sdk";
import { initRewindSession, detectRewind } from "../utils/rewind-cache.js";
import { setTranscriptPath } from "../utils/execution-context.js";
import { writeTool } from "../utils/synthetic.js";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput, getPlanModeContext } from "../utils/plan-mode-detector.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { readTranscriptExact } from "../utils/transcript.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "../utils/transcript-presets.js";
import { evaluateRulesForStop, ALL_RULES } from "../rules/index.js";
import { getMostRecentMessage } from "../rules/response-align-stop.js";
import type { RuleContext } from "../rules/types.js";

/**
 * Stop Hook: Response Check
 *
 * This hook runs when the AI stops (text-only response, no tool calls).
 * Bootstraps the rule pipeline for Stop-eligible rules (responseAlignStopRule).
 */

async function main() {
  const input = await readStdinJson<StopHookInput>();

  setTranscriptPath(input.transcript_path);
  const sessionDir = getSessionDir(input.transcript_path);
  initRewindSession(sessionDir);

  if (await detectRewind(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  const stateManager = getSessionState(sessionDir);
  const state = await stateManager.load();

  const planMode =
    input.permission_mode !== undefined
      ? isPlanModeFromInput(input)
      : isPlanModeActive(input.transcript_path);

  const tx = await readTranscriptExact(input.transcript_path, FIRST_RESPONSE_STOP_COUNTS);
  if (tx.user.length === 0 || tx.assistant.length === 0) {
    exitAfterFlush(0);
    return;
  }

  const ctx: RuleContext = {
    hookEvent: "Stop",
    toolName: "",
    projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx: getPlanModeContext(planMode),
    subagent: isSubagent(input.transcript_path),
    assistantText: getMostRecentMessage(tx.assistant).content,
    userText: getMostRecentMessage(tx.user).content,
  };

  const result = await evaluateRulesForStop(ALL_RULES, ctx);

  if (result.decision === "block" && result.systemMessage) {
    await writeTool(input.transcript_path, input.session_id, "response-align-stop", result.systemMessage);
    exitAfterFlush(0, JSON.stringify({ decision: "block", reason: result.systemMessage }));
    return;
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  exitAfterFlush(0);
});
