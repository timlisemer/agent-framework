import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { formatPredictionContext } from "../utils/prediction-types.js";

export const predictionContextRule: PreToolRule = {
  name: "prediction-context",
  displayName: "Prediction Context",
  priority: 68,
  appealable: false,
  usesLlm: true,
  promptSection: `Check whether this tool call serves the user's stated intent based on the predictions/sentiment context provided.

You receive Tool Predictions: expected tools based on user intent analysis.
If expected tools are listed and the current tool is NOT expected, consider why - a mismatch is NOT automatic denial; only DENY if it clearly contradicts user intent.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    const prediction = ctx.state.currentPrediction ?? null;
    if (!prediction) return null;
    return { llmContext: `PREDICTIONS:\n${formatPredictionContext(prediction)}` };
  },
};
