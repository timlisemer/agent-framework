import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import {
  decidePrediction,
  EXPLICIT_PROHIBITION_RE,
} from "../utils/prediction-types.js";
import { extractFilePaths } from "./utils.js";
import {
  createPlanfileAuthorization,
} from "../utils/create-planfile.js";

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
      const createPlanfileAuthorized = !!createPlanfileAuthorization({
        toolName: ctx.toolName,
        rawToolName: ctx.rawToolName,
        toolInput: ctx.toolInput,
        planMode: ctx.planMode,
        currentPrediction: ctx.state.currentPrediction,
      });
      const currentLogicText = (ctx.latestUserTurn?.logicText ?? ctx.latestUserMessage ?? "").trim();
      const explicitNoTools = currentLogicText.length > 0
        ? EXPLICIT_PROHIBITION_RE.test(currentLogicText)
        : prediction.blockAllTools === true;
      if (
        createPlanfileAuthorized &&
        !decision.matchedExplicit &&
        !explicitNoTools
      ) {
        return null;
      }
      return { fastDeny: decision.reason ?? "Tool blocked by user-state prediction" };
    }
    return null;
  },
};
