import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { formatPredictionContext } from "../utils/prediction-types.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";
import { PREDICTION_CONTEXT_RULE_POLICY } from "./policies.js";

export const predictionContextRule: PreToolRule = {
  name: "prediction-context",
  displayName: "Prediction Context",
  priority: 68,
  appealable: false,
  usesLlm: true,
  evaluationAgent: RULE_GATE_AGENT,
  version: "1",
  configuration: PREDICTION_CONTEXT_RULE_POLICY,
  promptSection: `Check whether this tool call serves the user's stated intent based on the live latest user message and predictions/sentiment context provided.

You receive Tool Predictions: expected tools based on user intent analysis.
Cached predictions are historical context. If they conflict with the live latest user message, the live latest user intent wins.
If expected tools are listed and the current tool is NOT expected, consider why - a mismatch is NOT automatic denial; only DENY if it clearly contradicts user intent.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const prediction = ctx.state.currentPrediction ?? null;
    if (!prediction) return null;
    const latest = (
      ctx.latestUserTurn?.logicText ||
      ctx.latestUserMessage ||
      ""
    ).trim();
    const latestSection = latest
      ? `LIVE LATEST USER MESSAGE (authoritative on conflicts):\n${latest}\n\n`
      : "";
    return {
      llmContext: `${latestSection}PREDICTIONS (historical cached context):\n${formatPredictionContext(prediction)}`,
    };
  },
};
