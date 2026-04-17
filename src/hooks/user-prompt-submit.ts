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
 * classification (fast path), runs the SENTIMENT_AGENT under a hard 12s
 * timeout to refresh `state.currentPrediction`, then spawns background
 * summary-updater in intent mode.
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

  // --- Sentiment-aware prediction refresh (sync, hard 12s timeout) ---
  const reloadedState = await stateManager.load();
  const previousPrediction = reloadedState.currentPrediction;
  const recent = await readRecentUserMessages(
    input.transcript_path,
    reloadedState.currentWindowSize ?? 2,
    true,
  ).catch(() => "");
  const stripped = stripQuotedAndPastedContent(input.prompt);

  // Bypass formatValidation: a single haiku call instead of the up-to-3-call
  // retry chain. parseSentimentOutput will return null on garbage and we'll
  // write a NEUTRAL stale-reset below.
  const sentimentPromise = runAgent(
    { ...SENTIMENT_AGENT, formatValidation: undefined, workingDir: projectDir },
    {
      prompt: "Classify the user's most recent message and produce a sentiment-aware prediction.",
      context:
        `PREVIOUS PREDICTION:\n${previousPrediction ? formatPredictionContext(previousPrediction) : "(none)"}\n\n` +
        `FRUSTRATION STREAK: ${reloadedState.frustrationStreak ?? 0}\n` +
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
    if (parsed) {
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

      await stateManager.update((s) => ({
        ...s,
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
    } else if (previousPrediction) {
      // Don't carry stale anger forward when classification fails. Without this,
      // after the mid-turn clears were removed, a stale "angry" prediction can
      // persist indefinitely if every subsequent UserPromptSubmit's sentiment
      // call returns garbage.
      await stateManager.update((s) => ({
        ...s,
        currentPrediction: {
          mood: "neutral",
          trust: "normal",
          intent: "(sentiment parse failed; defaulted to neutral)",
          blockedIntent: "",
          explicitlyAllowedTools: [],
          explicitlyBlockedSubstrings: [],
          userMessageSnippet: input.prompt.slice(0, 200),
          timestamp: Date.now(),
        },
        // streak and window kept as-is (don't reward classification failure)
      }));
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
