import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import { decidePrediction } from "../utils/prediction-types.js";
import { getBlacklistHighlights } from "../utils/command-patterns.js";

export const predictionBlockRule: PreToolRule = {
  name: "prediction-block",
  displayName: "Prediction Block",
  priority: 35,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    const prediction = ctx.state.currentPrediction ?? null;
    if (!prediction) return null;

    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path || "";
    if (isEditTool(ctx.toolName) && isEditIntentExemptPath(filePath)) {
      return null;
    }

    const decision = decidePrediction(prediction, ctx.toolName, ctx.toolInput);
    if (decision.decision === "deny") {
      // Mood-driven denies defer to tool-approve's blacklist fastDeny so the
      // user sees the actionable alternative (e.g. "use mcp__agent-framework__check")
      // instead of a generic frustration message. Explicit user blocks
      // (matchedExplicit) and blockAllTools still win here.
      const isMoodDriven = !decision.matchedExplicit && !prediction.blockAllTools;
      if (isMoodDriven && getBlacklistHighlights(ctx.toolName, ctx.toolInput).length > 0) {
        return null;
      }
      return { fastDeny: decision.reason ?? "Tool blocked by user-state prediction" };
    }
    return null;
  },
};
