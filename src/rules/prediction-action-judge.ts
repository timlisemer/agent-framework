import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import { SENTIMENT_AGENT } from "../utils/agent-configs.js";
import { parseSentimentOutput } from "../utils/prediction-parser.js";
import { readRecentUserMessages } from "../utils/transcript.js";
import { formatPredictionContext, stringifyToolInput } from "../utils/prediction-types.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { getBlacklistHighlights } from "../utils/command-patterns.js";

export const predictionActionJudgeRule: PreToolRule = {
  name: "prediction-action-judge",
  displayName: "Action-alignment Judge",
  priority: 37,
  appealable: false,
  usesLlm: true,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    if (ctx.toolName === "AskUserQuestion") return null; // owned by prediction-question-judge (28)

    const prediction = ctx.state.currentPrediction;
    if (!prediction) return null;
    const intent = prediction.intent?.trim();
    if (!intent || intent.toLowerCase() === "unclear") return null;
    if (prediction.explicitlyAllowedTools.includes(ctx.toolName)) return null;

    // Gate the LLM call: only fire when there's actual alignment signal.
    const restrictiveOrBlockedIntent =
      prediction.mood === "angry" ||
      prediction.mood === "frustrated" ||
      prediction.trust === "low" ||
      (prediction.blockedIntent?.length ?? 0) > 0;

    const priorDenies = readToolLogEntries(ctx.sessionDir, 30).filter(
      (e) => e.status === "denied" && e.tool === ctx.toolName,
    );
    const hasPriorDenies = priorDenies.length > 0;

    const policySignals = getBlacklistHighlights(ctx.toolName, ctx.toolInput, ctx.projectDir);
    const hasPolicySignals = policySignals.length > 0;

    if (!restrictiveOrBlockedIntent && !hasPriorDenies && !hasPolicySignals) {
      return null;
    }

    const recent = await readRecentUserMessages(
      ctx.transcriptPath,
      ctx.state.currentWindowSize ?? 2,
      true,
    ).catch(() => "");

    const priorDeniesFormatted = priorDenies.length
      ? priorDenies
          .slice(-5)
          .map((e) => {
            const target = e.cmd ?? e.path ?? "";
            return `- ${e.tool}${target ? ` ${target.slice(0, 120)}` : ""} — ${e.reason ?? ""}`.trim();
          })
          .join("\n")
      : "(none)";

    const policySignalsFormatted = policySignals.length
      ? policySignals.map((s) => `- ${s}`).join("\n")
      : "(none)";

    const candidate =
      `TOOL: ${ctx.toolName}\n` +
      `INPUT: ${stringifyToolInput(ctx.toolInput).slice(0, 600)}`;

    const r = await runAgent(
      { ...SENTIMENT_AGENT, formatValidation: undefined, workingDir: ctx.projectDir },
      {
        prompt: "Judge whether the candidate tool call serves the user's pending action demand.",
        context:
          `PREVIOUS PREDICTION:\n${formatPredictionContext(prediction)}\n\n` +
          `FRUSTRATION STREAK: ${ctx.state.frustrationStreak ?? 0}\n` +
          `CURRENT WINDOW SIZE: ${ctx.state.currentWindowSize ?? 2}\n\n` +
          `RECENT USER MESSAGES (with [Tn] indices, T0 = newest):\n${recent}\n\n` +
          `LATEST USER MESSAGE:\n${prediction.userMessageSnippet}\n\n` +
          `PRIOR-DENIED-TOOL-CALLS (this session, newest last):\n${priorDeniesFormatted}\n\n` +
          `POLICY-SIGNALS:\n${policySignalsFormatted}\n\n` +
          `CANDIDATE-TOOL-CALL:\n${candidate}`,
      },
    );

    const parsed = parseSentimentOutput(r.output);
    if (!parsed) return null;
    if (parsed.actionAligned === "no") {
      const intentLine = prediction.intent ? ` Intent: ${prediction.intent}.` : "";
      const blockedLine = prediction.blockedIntent ? ` Blocked intent: ${prediction.blockedIntent}.` : "";
      return {
        fastDeny:
          `Tool call misaligned with user intent. User said: "${prediction.userMessageSnippet}".${intentLine}${blockedLine} Address the user's demand instead of calling ${ctx.toolName}.`,
      };
    }
    return null;
  },
};
