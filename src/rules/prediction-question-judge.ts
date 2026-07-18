import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { formatPredictionContext, predictionUserMessageForLogic } from "../utils/prediction-types.js";
import { formatAskUserQuestionsForStallingJudge, normalizeAskUserQuestions } from "../utils/ask-user-question.js";

/**
 * Prediction Question Judge (priority 28)
 *
 * Fires for AskUserQuestion under restrictive mood (angry/frustrated/low-trust).
 * Calls SENTIMENT_AGENT with the question text injected so the LLM judges
 * whether asking this question RIGHT NOW is stalling. Legitimate ops
 * questions ("delete or back up first?") are allowed; bare deflections
 * ("what do you want me to do?") are denied.
 *
 * Runs BEFORE question-validate (priority 30) because question-validate
 * returns fastAllow which terminates the pipeline - anything at priority > 30
 * would never run for AskUserQuestion.
 */
export const predictionQuestionJudgeRule: PreToolRule = {
  name: "prediction-question-judge",
  displayName: "Question-stalling Judge",
  priority: 28,
  appealable: false,
  usesLlm: true,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== "AskUserQuestion") return null;
    const prediction = ctx.state.currentPrediction;
    if (!prediction) return null;
    const restrictive =
      prediction.mood === "angry" ||
      prediction.mood === "frustrated" ||
      prediction.trust === "low";
    if (!restrictive) return null;

    if (normalizeAskUserQuestions(ctx.toolInput).length === 0) return null;
    const askPayload = formatAskUserQuestionsForStallingJudge(ctx.toolInput);

    const recent = await readRecentUserMessages(
      ctx.transcriptPath,
      ctx.state.currentWindowSize ?? 2,
      true,
      { stripQuoted: false },
    ).catch(() => "");
    const userMessageForLogic = predictionUserMessageForLogic(prediction);

    const r = await runAgent(
      { ...SENTIMENT_AGENT, formatValidation: undefined, workingDir: ctx.projectDir },
      {
        prompt: "Judge whether asking this question right now is stalling.",
        context:
          `PREVIOUS PREDICTION:\n${formatPredictionContext(prediction)}\n\n` +
          `FRUSTRATION STREAK: ${ctx.state.frustrationStreak ?? 0}\n` +
          `CURRENT WINDOW SIZE: ${ctx.state.currentWindowSize ?? 2}\n\n` +
          `RECENT USER MESSAGES (with [Tn] indices, T0 = newest):\n${recent}\n\n` +
          `LATEST USER MESSAGE:\n${userMessageForLogic}\n\n` +
          `ASKUSERQUESTION CONTENT:\n${askPayload}`,
      },
      { signal: ctx.signal },
    );

    const parsed = parseSentimentOutput(r.output);
    if (!parsed) return null; // fail-open
    if (parsed.questionIsStalling === "yes") {
      return {
        fastDeny:
          `User is ${prediction.mood} (trust ${prediction.trust}). The question being asked is stalling - answer the user's existing request instead. User said: "${prediction.userMessageSnippet}".`,
      };
    }
    return null;
  },
};
