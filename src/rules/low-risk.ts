import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { LOW_RISK_TOOLS } from "./utils.js";
import { writeTool } from "../utils/synthetic.js";
import { deactivateAllPredictions } from "../utils/prediction-cache.js";
import { getSessionDir } from "../utils/summary-cache.js";

export const lowRiskRule: PreToolRule = {
  name: "low-risk-bypass",
  displayName: "Low Risk",
  priority: 10,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Synthetic message for entering plan mode (side effect before auto-approve)
    if (ctx.toolName === "EnterPlanMode" && !ctx.subagent) {
      await writeTool(
        ctx.transcriptPath,
        ctx.sessionId,
        "EnterPlanMode",
        "Entering plan mode. All subsequent tool calls are read-only until ExitPlanMode."
      );
      const sessionDir = getSessionDir(ctx.transcriptPath);
      await deactivateAllPredictions(sessionDir);
    }

    if (
      LOW_RISK_TOOLS.includes(ctx.toolName) ||
      (ctx.toolName.startsWith("mcp__") && !/(commit|push|confirm)$/.test(ctx.toolName))
    ) {
      return { fastAllow: "Low-risk tool auto-approval" };
    }

    return null;
  },
};
