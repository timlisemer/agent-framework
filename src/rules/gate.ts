import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { GATE_AGENT } from "../utils/agent-configs.js";
import {
  getSummaryPath,
  readSection,
} from "../utils/summary-cache.js";
import {
  formatForPrompt,
} from "../utils/gate-reasoning-cache.js";
import {
  getActivePrediction,
  formatPredictionContext,
} from "../utils/prediction-cache.js";

export const gateRule: PreToolRule = {
  name: "gate",
  displayName: "Gate",
  priority: 70,
  appealable: true,
  usesLlm: true,
  promptSection: GATE_AGENT.systemPrompt,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.useSyncPipeline) {
      return null;
    }

    let userIntent = "";
    let misalignments = "";
    let gateReasoning = "";
    try {
      const summaryPath = getSummaryPath(ctx.transcriptPath);
      userIntent = await readSection(summaryPath, "User Intent");
      misalignments = await readSection(summaryPath, "Flagged Misalignments");
      gateReasoning = await formatForPrompt(ctx.sessionDir);
    } catch {
      // No summary yet - proceed without context
    }

    // Read predictions and edit intent for gate context
    let predictions: string | undefined;
    try {
      const prediction = await getActivePrediction(ctx.sessionDir);
      if (prediction) {
        predictions = formatPredictionContext(prediction);
      }
    } catch {
      // Non-fatal
    }
    const editIntent = ctx.state.currentEditIntent ?? null;

    let llmContextParts: string[] = [];
    if (userIntent) llmContextParts.push(`USER INTENT:\n${userIntent}`);
    if (misalignments) llmContextParts.push(`FLAGGED MISALIGNMENTS:\n${misalignments}`);
    if (gateReasoning) llmContextParts.push(`GATE REASONING HISTORY:\n${gateReasoning}`);
    if (predictions) llmContextParts.push(`PREDICTIONS:\n${predictions}`);
    llmContextParts.push(`EDIT INTENT: ${editIntent}`);
    if (ctx.planModeCtx.active) llmContextParts.push(ctx.planModeCtx.contextString);

    return {
      llmContext: llmContextParts.join("\n\n"),
    };
  },
};
