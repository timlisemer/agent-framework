import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isLowRiskTool } from "./utils.js";
import { writeTool } from "../utils/synthetic.js";

export const lowRiskRule: PreToolRule = {
  name: "low-risk-bypass",
  displayName: "Low Risk",
  priority: 38,
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
    }

    if (isLowRiskTool(ctx.toolName)) {
      return { fastAllow: "Low-risk tool auto-approval" };
    }

    return null;
  },
};
