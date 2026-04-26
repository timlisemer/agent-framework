import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isLowRiskTool } from "./utils.js";
import { writeTool } from "../utils/synthetic.js";
import { isSustainedFrustration } from "../utils/prediction-types.js";

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
      // Mirror decidePrediction's sustained-frustration carve-out: when the
      // user is angry/frustrated AND (low trust OR frustrationStreak >= 2),
      // a low-risk read/grep is tangential inspection, not benign discovery.
      // Defer to prediction-block (priority 99) by returning null instead of
      // fastAllow. Prior to respond-first becoming purely deterministic, this
      // case was incidentally covered by respond-first's llmContext keeping
      // the fastAllow guard active; that coverage went away when respond-first
      // stopped returning llmContext.
      const prediction = ctx.state.currentPrediction ?? null;
      const frustrationStreak = ctx.state.frustrationStreak ?? 0;
      if (prediction && isSustainedFrustration(prediction, frustrationStreak)) {
        return null;
      }
      return { fastAllow: "Low-risk tool auto-approval" };
    }

    return null;
  },
};
