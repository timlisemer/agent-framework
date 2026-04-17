import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import * as path from "path";
import { fileURLToPath } from "url";
import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { spawnBackground } from "../utils/spawn-background.js";
import { getSessionDir, getSessionState } from "../utils/summary-cache.js";
import { isPlanModeActive, isPlanModeFromInput } from "../utils/plan-mode-detector.js";
import { classifyEditIntent } from "../utils/edit-intent.js";
import { clearCorrections } from "../utils/correction-cache.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { formatPredictionContext } from "../utils/prediction-types.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Performs synchronous edit intent
 * classification (fast path), runs the SENTIMENT_AGENT under a hard 6s
 * timeout to refresh `state.currentPrediction`, then spawns background
 * summary-updater in intent mode.
 */

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
  session_id: string;
  permission_mode?: string;
}

const SENTIMENT_TIMEOUT_MS = 6000;

async function main() {
  const input = await readStdinJson<UserPromptSubmitHookInput>();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Skip for subagents
  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  // --- Synchronous edit intent classification (fast path) ---
  const sessionDir = getSessionDir(input.transcript_path);
  const stateManager = getSessionState(sessionDir);
  const oldState = await stateManager.load();

  const planMode = input.permission_mode !== undefined
    ? isPlanModeFromInput(input)
    : isPlanModeActive(input.transcript_path);
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
    respondFirstChecked: false,
  }));

  // Clear stale corrections from previous turn
  await clearCorrections(sessionDir);

  // --- Sentiment-aware prediction refresh (sync, hard 6s timeout) ---
  const previousPrediction = (await stateManager.load()).currentPrediction;
  const recent = await readRecentUserMessages(input.transcript_path, 5).catch(() => "");
  const stripped = stripQuotedAndPastedContent(input.prompt);

  const sentimentPromise = runAgent(
    { ...SENTIMENT_AGENT, workingDir: projectDir },
    {
      prompt: "Classify the user's most recent message and produce a sentiment-aware prediction.",
      context:
        `PREVIOUS PREDICTION:\n${previousPrediction ? formatPredictionContext(previousPrediction) : "(none — first message)"}\n\n` +
        `RECENT USER MESSAGES (newest last):\n${recent}\n\n` +
        `LATEST USER MESSAGE:\n${stripped}`,
    }
  );
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), SENTIMENT_TIMEOUT_MS)
  );

  try {
    const sentimentResult = await Promise.race([sentimentPromise, timeoutPromise]);
    if (sentimentResult) {
      const parsed = parseSentimentOutput(sentimentResult.output);
      if (parsed) {
        await stateManager.update((s) => ({
          ...s,
          currentPrediction: {
            ...parsed,
            userMessageSnippet: input.prompt.slice(0, 200),
            timestamp: Date.now(),
          },
        }));
      }
    }
  } catch (err) {
    console.error("[user-prompt-submit] sentiment agent failed:", err);
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
