import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import {
  getAllPredictions,
  deactivateAllPredictions,
  matchBlockedToolFromAll,
} from "../utils/prediction-cache.js";

export const predictionBlockRule: PreToolRule = {
  name: "prediction-block",
  displayName: "Prediction Block",
  priority: 35,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) {
      return null;
    }

    // Deactivate all predictions for MCP commit/push/confirm/check tools
    if (ctx.toolName.startsWith("mcp__") && /(commit|push|confirm|check)$/.test(ctx.toolName)) {
      await deactivateAllPredictions(ctx.sessionDir);
    }

    const allPredictions = await getAllPredictions(ctx.sessionDir);
    if (allPredictions.length === 0) {
      return null;
    }

    const predFilePath = (ctx.toolInput as { file_path?: string }).file_path || (ctx.toolInput as { path?: string }).path || "";
    if (isEditTool(ctx.toolName) && isEditIntentExemptPath(predFilePath)) {
      // Exempt paths skip prediction blocking -- they have their own validators
      return null;
    }

    const blockedResult = matchBlockedToolFromAll(ctx.toolName, ctx.toolInput, allPredictions);
    if (blockedResult) {
      const blockReason = `Tool "${ctx.toolName}" is not aligned with current user intent. ${blockedResult.blocked.reason}`;
      return { fastDeny: blockReason };
    }

    return null;
  },
};
