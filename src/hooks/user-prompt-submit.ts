import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput } from "../utils/plan-mode-detector.js";
import { deriveEditIntentFromPrediction } from "../utils/edit-intent.js";
import { clearGateReasoning } from "../utils/gate-reasoning-cache.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";
import { logError } from "../utils/logger.js";
import { MODEL_TIERS, EXECUTION_TYPES, getModelId } from "../types.js";

/**
 * UserPromptSubmit Hook
 *
 * Fires when the user submits a prompt. Runs the SENTIMENT_AGENT under a
 * hard 12s timeout to refresh `state.currentPrediction`, then derives
 * `currentEditIntent` from the prediction.
 */

interface UserPromptSubmitHookInput {
  prompt: string;
  transcript_path: string;
  session_id: string;
  permission_mode?: string;
}

const SENTIMENT_TIMEOUT_MS = 12000;

async function main() {
  const input = await readStdinJson<UserPromptSubmitHookInput>();
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Skip for subagents
  if (isSubagent(input.transcript_path)) {
    exitAfterFlush(0);
    return;
  }

  const sessionDir = getSessionDir(input.transcript_path);
  const stateManager = getSessionState(sessionDir);

  const planMode = input.permission_mode !== undefined
    ? isPlanModeFromInput(input)
    : isPlanModeActive(input.transcript_path);

  // --- Sentiment-aware prediction refresh (sync, hard 12s timeout) ---
  const reloadedState = await stateManager.load();
  const previousPrediction = reloadedState.currentPrediction;
  const recent = await readRecentUserMessages(
    input.transcript_path,
    reloadedState.currentWindowSize ?? 2,
    true,
  ).catch(() => "");
  const stripped = stripQuotedAndPastedContent(input.prompt);

  // Use SENTIMENT_AGENT's built-in formatValidation so malformed haiku output
  // triggers the tiered retry chain (haiku -> haiku -> haiku) with the marker-
  // format reminder. The retries run inside the outer 12s Promise.race.
  // Note: formatValidation retries only fix MARKER-FORMAT failures -- they
  // do not re-prompt with the full system prompt, so they cannot correct a
  // semantic misclassification. Prompt-level fixes in SENTIMENT_AGENT are
  // responsible for classification quality; this restoration is purely about
  // robust flow-control so parse failures reach the explicit failure branch
  // below instead of landing on the previous silent-neutral overwrite path.
  // Show only mood+trust+intent for PREVIOUS PREDICTION. Stale blockedIntent
  // and explicit-block/allow lists anchor haiku toward holding at angry even
  // when STEP 4 of the prompt tells it to re-derive those fields per-turn.
  // Not showing them at all makes the prompt robust to haiku partially
  // following STEP 4 instructions.
  const previousSummary = previousPrediction
    ? `User mood: ${previousPrediction.mood}\nUser trust: ${previousPrediction.trust}\nIntent: ${previousPrediction.intent}`
    : "(none)";
  const sentimentPromise = runAgent(
    { ...SENTIMENT_AGENT, workingDir: projectDir },
    {
      prompt: "Classify the user's most recent message and produce a sentiment-aware prediction.",
      context:
        `PREVIOUS PREDICTION (historical context -- re-evaluate LATEST on its own terms, do NOT copy forward):\n${previousSummary}\n\n` +
        `FRUSTRATION STREAK (informational -- TS applies promotion deterministically after you output): ${reloadedState.frustrationStreak ?? 0}\n` +
        `CURRENT WINDOW SIZE: ${reloadedState.currentWindowSize ?? 2}\n\n` +
        `RECENT USER MESSAGES (with [Tn] indices, T0 = newest):\n${recent}\n\n` +
        `LATEST USER MESSAGE:\n${stripped}`,
    }
  );
  const timeoutPromise = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), SENTIMENT_TIMEOUT_MS)
  );

  try {
    const sentimentResult = await Promise.race([sentimentPromise, timeoutPromise]);
    const parsed = sentimentResult ? parseSentimentOutput(sentimentResult.output) : null;
    // sentimentResult.success is false when runAgent returned its fallbackOutput
    // template after exhausting format-validation retries. Treat that as a real
    // failure even though parsed is non-null -- don't write "unclear" over a
    // real prior classification.
    if (parsed && sentimentResult?.success) {
      const oldStreak = reloadedState.frustrationStreak ?? 0;
      const oldWindow = reloadedState.currentWindowSize ?? 2;
      const negativeMood = parsed.mood === "angry" || parsed.mood === "frustrated";
      const newStreak = negativeMood ? Math.min(oldStreak + 1, 5) : 0;

      // Streak hardening (TS-side, deterministic):
      let effectiveMood = parsed.mood;
      if (newStreak >= 3) {
        if (parsed.mood === "frustrated") effectiveMood = "angry";
        else if (parsed.mood === "neutral") effectiveMood = "frustrated";
      }
      const effectiveTrust = newStreak >= 5 ? "low" : parsed.trust;

      // Window size: ORDER MATTERS. Apply growth guards FIRST, then
      // context-switch cap LAST, so context-switch always wins (per user
      // intent: "should reduce the window" on topic change).
      let nextWindow = Number.isFinite(parsed.nextWindowSize)
        ? Math.round(parsed.nextWindowSize as number)
        : oldWindow;

      // Growth guard 1: streak rising forces growth even if LLM didn't propose it.
      if (newStreak > oldStreak && nextWindow < oldWindow + 2) {
        nextWindow = Math.min(15, oldWindow + 2);
      }
      // Growth guard 2: mood SHIFT forces growth. Compare effectiveMood
      // (post-streak promotion) against previous so TS-promoted shifts also
      // trigger growth.
      const prevMood = previousPrediction?.mood;
      const shifted = prevMood && prevMood !== effectiveMood;
      const oneIsHostile = (m?: string) => m === "angry" || m === "frustrated";
      if (shifted && (oneIsHostile(prevMood) || oneIsHostile(effectiveMood))) {
        nextWindow = Math.min(15, Math.max(nextWindow, oldWindow + 3));
      }
      // Context-switch cap LAST — overrides any growth above.
      if (parsed.contextSwitch === "yes") {
        nextWindow = Math.min(nextWindow, 3);
      }
      nextWindow = Math.max(2, Math.min(15, nextWindow));

      const predictionForDerivation = {
        ...parsed,
        userMessageSnippet: input.prompt.slice(0, 200),
        timestamp: Date.now(),
      };
      const derivedEditIntent = deriveEditIntentFromPrediction(predictionForDerivation);
      const finalEditIntent = planMode ? false : derivedEditIntent;

      if (parsed.contextSwitch === "yes") {
        await clearGateReasoning(sessionDir);
      }
      await stateManager.update((s) => ({
        ...s,
        previousEditIntent: s.currentEditIntent ?? null,
        currentEditIntent: finalEditIntent,
        editIntentTimestamp: Date.now(),
        editIntentOverturnCount: 0,
        respondFirstChecked: false,
        frustrationStreak: newStreak,
        currentWindowSize: nextWindow,
        currentPrediction: {
          ...parsed,
          mood: effectiveMood,
          trust: effectiveTrust,
          userMessageSnippet: input.prompt.slice(0, 200),
          timestamp: Date.now(),
        },
      }));
    } else {
      // Parse failed AFTER runAgent's format-validation retry chain ran (or
      // timed out). This is the honest failure mode: we could not classify
      // this turn. Log via telemetry + stderr so operators see it, and KEEP
      // the previous prediction untouched. No phantom neutral write --
      // downstream rules operate on the last known real classification.
      const reason = !sentimentResult
        ? "sentiment agent timed out (12s)"
        : !sentimentResult.success
          ? "sentiment output unparseable after format-validation retries exhausted"
          : "sentiment output failed structural parse";
      const telemetryResult = sentimentResult ?? {
        output: "(no output)",
        latencyMs: SENTIMENT_TIMEOUT_MS,
        success: false,
        errorCount: 1,
        modelTier: MODEL_TIERS.HAIKU,
        modelName: getModelId(MODEL_TIERS.HAIKU),
      };
      logError(
        telemetryResult,
        "sentiment",
        "UserPromptSubmit",
        "(classify-prompt)",
        projectDir,
        EXECUTION_TYPES.LLM,
        `${reason}; keeping previous prediction. raw (first 500 chars): ${sentimentResult?.output?.slice(0, 500) ?? "(no output)"}`
      );
      console.error(
        `[user-prompt-submit] ${reason}; keeping previous prediction.`
      );
      // Clear only edit-intent bookkeeping so stale edit-intent doesn't
      // linger across a classification-failed turn. currentPrediction,
      // frustrationStreak, currentWindowSize stay exactly as they were.
      await stateManager.update((s) => ({
        ...s,
        previousEditIntent: s.currentEditIntent ?? null,
        currentEditIntent: null,
        editIntentTimestamp: Date.now(),
        editIntentOverturnCount: 0,
        respondFirstChecked: false,
      }));
    }
  } catch (err) {
    console.error("[user-prompt-submit] sentiment agent failed:", err);
  }

  exitAfterFlush(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(0);
});
