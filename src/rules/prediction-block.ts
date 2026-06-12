import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import { decidePrediction } from "../utils/prediction-types.js";
import { extractFilePaths } from "./utils.js";

export const predictionBlockRule: PreToolRule = {
  name: "prediction-block",
  displayName: "Prediction Block",
  priority: 35,
  // Keep deterministic for now. This rule used to be appealable, but the
  // appeal path overruled most prediction blocks; first try targeted logic
  // fixes without re-opening that behavior.
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const prediction = ctx.state.currentPrediction ?? null;
    if (!prediction) return null;

    const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
    if (
      isEditTool(ctx.toolName) &&
      filePaths.length > 0 &&
      filePaths.every((filePath) => isEditIntentExemptPath(filePath, ctx.sessionDir))
    ) {
      return null;
    }

    const decision = decidePrediction(
      prediction,
      ctx.toolName,
      ctx.toolInput,
      ctx.state.frustrationStreak ?? 0,
      ctx.latestUserMessage ?? "",
      ctx.recentUserMessages ?? [],
      ctx.cachedSnippetSideTaskDischarged ?? false,
      ctx.slashCommandAllowedTools ?? [],
      ctx.latestUserTurn,
    );
    if (decision.decision === "deny") {
      return { fastDeny: decision.reason ?? "Tool blocked by user-state prediction" };
    }
    return null;
  },
};
