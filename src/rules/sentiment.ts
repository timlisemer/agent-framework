import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { stripQuotedAndPastedContent } from "../utils/quote-detection.js";
import { logError } from "../utils/logger.js";
import { MODEL_TIERS, EXECUTION_TYPES } from "../types.js";
import {
  EXPLICIT_OVERRIDE_RE,
  classifyBlockAllTools,
  decideNextWindowSize,
  deriveWorkflowToolRequirementsFromText,
  uniqueToolRequirements,
} from "../utils/prediction-types.js";
import type { ToolRequirement } from "../utils/prediction-schema.js";
import { preClassifyMood, extractDirectiveHint, preClassifyCalm } from "../utils/sentiment-prefilter.js";
import {
  deriveEditIntentFromPrediction,
  deriveAllowedToolsFromIntent,
} from "../utils/edit-intent.js";
import { isCancellationError } from "../utils/cancellation.js";

const SENTIMENT_TIMEOUT_MS = 12000;

function dropWorkflowBroadAllows(
  explicitlyAllowedTools: readonly string[],
  explicitlyRequiredTools: readonly ToolRequirement[],
): string[] {
  if (explicitlyRequiredTools.length === 0) return [...explicitlyAllowedTools];
  return [];
}

export const sentimentRule: PreToolRule = {
  name: "sentiment",
  displayName: "Sentiment",
  priority: 10,
  appealable: false,
  usesLlm: true,
  events: ["UserPromptSubmit"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.userPrompt) return null;

    const userPrompt = ctx.userPrompt;
    const projectDir = ctx.projectDir;
    const planMode = ctx.planMode;
    const stateManager = ctx.stateManager;

    // Re-load state to preserve current `reloadedState` semantics from user-prompt-submit.ts
    const reloadedState = await stateManager.load();
    const previousPrediction = reloadedState.currentPrediction;
    const recent = await readRecentUserMessages(
      ctx.transcriptPath,
      reloadedState.currentWindowSize ?? 2,
      true,
      { stripQuoted: false },
    ).catch(() => "");
    const strippedForPrefilter = stripQuotedAndPastedContent(userPrompt);

    const previousSummary = previousPrediction
      ? `User mood: ${previousPrediction.mood}\nUser trust: ${previousPrediction.trust}\nIntent: ${previousPrediction.intent}`
      : "(none)";

    const moodPrefilter = preClassifyMood(strippedForPrefilter);
    const moodHintSection =
      moodPrefilter.hint || moodPrefilter.interruptCount > 0
        ? `MOOD HINT (regex pre-classifier - judge LATEST yourself; honor only when its first-person hostility is directed at you):\n` +
          `  hint: ${moodPrefilter.hint ?? "none"}\n` +
          `  interruptCount: ${moodPrefilter.interruptCount}\n\n`
        : "";

    const directiveHint = extractDirectiveHint(strippedForPrefilter);
    const directiveHintSection = directiveHint
      ? `DIRECTIVE HINT (regex pre-extractor - last imperative sentence in full LATEST; the user's directive should be reflected in INTENT):\n  ${JSON.stringify(directiveHint)}\n\n`
      : "";

    const strippedHelperSection = strippedForPrefilter !== userPrompt
      ? `LATEST USER MESSAGE WITH QUOTED/PASTED CONTENT REMOVED (helper only; raw message above is authoritative):\n${strippedForPrefilter}\n\n`
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
          directiveHintSection +
          `RECENT USER MESSAGES (with [Tn] indices, T0 = newest; full unstripped text):\n${recent}\n\n` +
          `LATEST USER MESSAGE (authoritative full unstripped text):\n${userPrompt}\n\n` +
          strippedHelperSection,
      },
      { signal: ctx.signal },
    );
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), SENTIMENT_TIMEOUT_MS)
    );

    try {
      const sentimentResult = await Promise.race([sentimentPromise, timeoutPromise]);
      const parsed = sentimentResult ? parseSentimentOutput(sentimentResult.output) : null;
      if (parsed && sentimentResult?.success) {
        // TS-side overrides
        parsed.explicitlyAllowedTools = [
          ...new Set([
            ...parsed.explicitlyAllowedTools,
            ...deriveAllowedToolsFromIntent(userPrompt),
          ]),
        ];

        const workflowRequirements = deriveWorkflowToolRequirementsFromText(userPrompt);
        if (workflowRequirements.explicitlyRequiredTools.length > 0) {
          parsed.explicitlyRequiredTools = [
            ...(parsed.explicitlyRequiredTools ?? []),
            ...workflowRequirements.explicitlyRequiredTools,
          ];
          parsed.explicitlyAllowedTools = dropWorkflowBroadAllows(
            parsed.explicitlyAllowedTools,
            workflowRequirements.explicitlyRequiredTools,
          );
          parsed.nonBlockingTools = uniqueToolRequirements([
            ...(parsed.nonBlockingTools ?? []),
            ...workflowRequirements.nonBlockingTools,
          ]);
        }

        const blockClass = classifyBlockAllTools(userPrompt);
        if (blockClass === "yes") parsed.blockAllTools = true;
        else if (blockClass === "no") parsed.blockAllTools = false;

        if (moodPrefilter.interruptCount >= 2) {
          parsed.mood = "angry";
        } else if (moodPrefilter.hint && parsed.mood !== moodPrefilter.hint) {
          console.error(
            `[sentiment-rule] mood-hint disagreement: regex says ${moodPrefilter.hint}, LLM says ${parsed.mood} (no override)`,
          );
        }

        if (preClassifyCalm(strippedForPrefilter, directiveHint)) {
          if (parsed.mood === "angry" || parsed.mood === "frustrated") {
            parsed.mood = "neutral";
          }
          if (parsed.trust === "low") {
            parsed.trust = "normal";
          }
          parsed.intent = directiveHint;
        }

        const oldStreak = reloadedState.frustrationStreak ?? 0;
        const oldWindow = reloadedState.currentWindowSize ?? 2;
        const negativeMood = parsed.mood === "angry" || parsed.mood === "frustrated";
        const newStreak = negativeMood ? Math.min(oldStreak + 1, 5) : 0;

        let effectiveMood = parsed.mood;
        if (newStreak >= 3) {
          if (parsed.mood === "frustrated") effectiveMood = "angry";
          else if (parsed.mood === "neutral") effectiveMood = "frustrated";
        }
        const effectiveTrust = newStreak >= 5 ? "low" : parsed.trust;

        const prevMood = previousPrediction?.mood;
        const nextWindow = decideNextWindowSize({
          oldWindow,
          oldStreak,
          newStreak,
          prevMood,
          effectiveMood,
          contextSwitch: parsed.contextSwitch ?? "no",
        });

        const hasExplicitOverride = EXPLICIT_OVERRIDE_RE.test(userPrompt);

        const predictionForDerivation = {
          ...parsed,
          userMessageFull: userPrompt,
          userMessageSnippet: userPrompt.slice(0, 200),
          timestamp: Date.now(),
        };
        const derivedEditIntent = deriveEditIntentFromPrediction(predictionForDerivation);
        const finalEditIntent = planMode ? false : derivedEditIntent;

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
            userMessageFull: userPrompt,
            userMessageSnippet: userPrompt.slice(0, 200),
            timestamp: Date.now(),
            hasExplicitOverride,
          },
          lastProcessedPlanApprovalToolUseId: null,
          driftState: {},
          lastUserMessageTimestamp: Date.now(),
          gateReasoningResetAt: parsed.contextSwitch === "yes" ? Date.now() : s.gateReasoningResetAt,
        }));
      } else {
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
          modelName: "timeout",
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
          `[sentiment-rule] ${reason}; keeping previous prediction.`
        );
        await stateManager.update((s) => ({
          ...s,
          previousEditIntent: s.currentEditIntent ?? null,
          currentEditIntent: null,
          editIntentTimestamp: Date.now(),
          editIntentOverturnCount: 0,
          respondFirstChecked: false,
          driftState: {},
          lastUserMessageTimestamp: Date.now(),
        }));
      }
    } catch (err) {
      if (isCancellationError(err)) throw err;
      console.error("[sentiment-rule] sentiment agent failed:", err);
    }

    return null;
  },
};
