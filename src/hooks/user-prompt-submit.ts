import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { readStdinJson, exitAfterFlush, initHookProcess } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput, getPlanModeContext } from "../utils/plan-mode-detector.js";
import { evaluateRulesForUserPromptSubmit, ALL_RULES } from "../rules/index.js";
import type { RuleContext } from "../rules/types.js";

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Bootstraps the rule pipeline for
 * UserPromptSubmit-eligible rules (currently sentimentRule). Rules run purely
 * for side-effects (e.g., writing state.currentPrediction).
 */

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
  session_id: string;
  permission_mode?: string;
}

async function main() {
  const input = await readStdinJson<UserPromptSubmitHookInput>();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  initHookProcess(input.transcript_path);

  const sessionDir = getSessionDir(input.transcript_path);
  const stateManager = getSessionState(sessionDir);
  const state = await stateManager.load();

  const planMode =
    input.permission_mode !== undefined
      ? isPlanModeFromInput(input)
      : isPlanModeActive(input.transcript_path);

  const ctx: RuleContext = {
    hookEvent: "UserPromptSubmit",
    toolName: "",
    userPrompt: input.prompt,
    projectDir,
    transcriptPath: input.transcript_path,
    sessionDir,
    sessionId: input.session_id,
    state,
    stateManager,
    planMode,
    planModeCtx: getPlanModeContext(planMode),
    subagent: false,
  };

  await evaluateRulesForUserPromptSubmit(ALL_RULES, ctx);
  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
