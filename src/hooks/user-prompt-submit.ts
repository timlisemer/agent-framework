import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as path from "path";
import { fileURLToPath } from "url";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { spawnBackground } from "../utils/spawn-background.js";
import { getSessionDir, getSessionState } from "../utils/summary-cache.js";
import { isPlanModeActive } from "../utils/plan-mode-detector.js";
import { classifyEditIntent } from "../utils/edit-intent.js";
import { generateMicroPredictions } from "../utils/micro-prediction.js";
import { savePrediction } from "../utils/prediction-cache.js";
import { clearCorrections } from "../utils/correction-cache.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Performs synchronous edit intent
 * classification (fast path), then spawns background summary-updater
 * in intent mode to update User Intent, User Approvals, and LLM fallback
 * for ambiguous edit intent classification.
 */

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
  session_id: string;
}

async function main() {
  const input = await readStdinJson<UserPromptSubmitHookInput>();

  // Skip for subagents
  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  // --- Synchronous edit intent classification (fast path) ---
  const sessionDir = getSessionDir(input.transcript_path);
  const stateManager = getSessionState(sessionDir);
  const oldState = await stateManager.load();

  const planMode = isPlanModeActive(input.transcript_path);
  const now = Date.now();

  const result = classifyEditIntent(
    input.prompt,
    oldState.currentEditIntent ?? null,
    oldState.editIntentTimestamp ?? 0,
    planMode
  );

  // ATOMIC WRITE: single stateManager.update call
  await stateManager.update((s) => ({
    ...s,
    previousEditIntent: s.currentEditIntent ?? null,
    currentEditIntent: result,
    editIntentTimestamp: now,
    editIntentOverturnCount: 0,
  }));

  // Clear stale corrections from previous turn
  await clearCorrections(sessionDir);

  // Generate synchronous micro-predictions
  const microPrediction = generateMicroPredictions(input.prompt, result, planMode);
  if (microPrediction.blockedTools.length > 0 || (microPrediction.allowedTools?.length ?? 0) > 0) {
    await savePrediction(sessionDir, microPrediction);
  }

  // Spawn background summary-updater in intent mode
  const updaterPath = path.join(__dirname, "../utils/summary-updater.js");
  const encodedPrompt = Buffer.from(input.prompt).toString("base64");

  spawnBackground(updaterPath, [
    "--mode", "intent",
    "--transcript", input.transcript_path,
    "--prompt", encodedPrompt,
    "--session-id", input.session_id,
  ], { dedupKey: "summary-updater-intent", sessionDir });

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
