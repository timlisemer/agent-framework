import "../utils/load-env.js";
import { initializeTelemetry } from "../telemetry/index.js";
initializeTelemetry();

import { readStdinJson, exitAfterFlush } from "../utils/hook-bootstrap.js";
import { isSubagent } from "../utils/subagent-detector.js";
import { getSessionDir, getSessionState } from "../utils/session-store.js";
import { isPlanModeActive, isPlanModeFromInput } from "../utils/plan-mode-detector.js";
import {
  deriveEditIntentFromPrediction,
  deriveAllowedToolsFromIntent,
} from "../utils/edit-intent.js";
import { clearGateReasoning } from "../utils/gate-reasoning-cache.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";
import { logError } from "../utils/logger.js";
import { MODEL_TIERS, EXECUTION_TYPES, getModelId } from "../types.js";
import {
  EXPLICIT_OVERRIDE_RE,
  classifyBlockAllTools,
  decideNextWindowSize,
} from "../utils/prediction-types.js";
import { preClassifyMood } from "../utils/sentiment-prefilter.js";

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

  // Pre-classify mood from the stripped message — surfaced to the prompt as
  // a MOOD HINT block. The LLM remains primary for mood quality; only the
  // ">=2 interrupts" hint is hard-overridden TS-side after the parse.
  const moodPrefilter = preClassifyMood(stripped);
  const moodHintSection =
    moodPrefilter.hint || moodPrefilter.interruptCount > 0
      ? `MOOD HINT (regex pre-classifier — judge LATEST yourself; honor only when its first-person hostility is directed at you):\n` +
        `  hint: ${moodPrefilter.hint ?? "none"}\n` +
        `  interruptCount: ${moodPrefilter.interruptCount}\n\n`
      : "";

  const sentimentPromise = runAgent(
    { ...SENTIMENT_AGENT, workingDir: projectDir },
    {
      prompt: "Classify the user's most recent message and produce a sentiment-aware prediction.",
      context:
        `PREVIOUS PREDICTION (historical context -- re-evaluate LATEST on its own terms, do NOT copy forward):\n${previousSummary}\n\n` +
        `FRUSTRATION STREAK (informational -- TS applies promotion deterministically after you output): ${reloadedState.frustrationStreak ?? 0}\n` +
        `CURRENT WINDOW SIZE: ${reloadedState.currentWindowSize ?? 2}\n\n` +
        moodHintSection +
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
      // TS-side overrides on parsed fields (Findings 6, 7, 14).
      // Finding 6: union the parsed allowed-tools list with the deterministic
      // verb-derived list. Safe because per-target explicit-block now precedes
      // explicit-allow in decidePrediction.
      parsed.explicitlyAllowedTools = [
        ...new Set([
          ...parsed.explicitlyAllowedTools,
          ...deriveAllowedToolsFromIntent(stripped),
        ]),
      ];

      // Finding 7: classifyBlockAllTools overrides the LLM when the morphology
      // is unambiguous; ambiguous cases trust the LLM.
      const blockClass = classifyBlockAllTools(stripped);
      if (blockClass === "yes") parsed.blockAllTools = true;
      else if (blockClass === "no") parsed.blockAllTools = false;

      // Finding 14: the SENTIMENT_AGENT prompt mandates angry classification
      // when there are >=2 [Request interrupted by user] entries. Honor that
      // hard rule TS-side; other hints log only.
      if (moodPrefilter.interruptCount >= 2) {
        parsed.mood = "angry";
      } else if (moodPrefilter.hint && parsed.mood !== moodPrefilter.hint) {
        console.error(
          `[user-prompt-submit] mood-hint disagreement: regex says ${moodPrefilter.hint}, LLM says ${parsed.mood} (no override)`,
        );
      }

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

      // Finding 13: window size is now decided entirely TS-side from the
      // parsed contextSwitch + previous/effective mood + streak deltas.
      const prevMood = previousPrediction?.mood;
      const nextWindow = decideNextWindowSize({
        oldWindow,
        oldStreak,
        newStreak,
        prevMood,
        effectiveMood,
        contextSwitch: parsed.contextSwitch ?? "no",
      });

      // Finding 9: compute hasExplicitOverride against the FULL prompt (not
      // the 200-char snippet) so late-appearing override phrases are caught.
      const hasExplicitOverride = EXPLICIT_OVERRIDE_RE.test(input.prompt);

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
        forceCheckPending: false,
        frustrationStreak: newStreak,
        currentWindowSize: nextWindow,
        currentPrediction: {
          ...parsed,
          mood: effectiveMood,
          trust: effectiveTrust,
          userMessageSnippet: input.prompt.slice(0, 200),
          timestamp: Date.now(),
          hasExplicitOverride,
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
        forceCheckPending: false,
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
