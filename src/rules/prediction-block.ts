import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import { decidePrediction } from "../utils/prediction-types.js";

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

    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path || "";
    if (isEditTool(ctx.toolName) && isEditIntentExemptPath(filePath)) {
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
    );
    if (decision.decision === "deny") {
      return { fastDeny: decision.reason ?? "Tool blocked by user-state prediction" };
    }
    return null;
  },
};
