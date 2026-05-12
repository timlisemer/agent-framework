import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isLowRiskTool } from "./utils.js";
import { writeTool } from "../utils/synthetic.js";

export const lowRiskRule: PreToolRule = {
  name: "low-risk-bypass",
  displayName: "Low Risk",
  // Keep this after force-check-required (32) so recovery lockout still wins,
  // but before blacklist/prediction-block. If early low-risk approval ever
  // allows distracting reads during hostile turns, move this back below
  // prediction-block and keep read-only Bash handled in decidePrediction.
  priority: 33,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Synthetic message for entering plan mode (side effect before auto-approve)
    if (ctx.toolName === "EnterPlanMode") {
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
