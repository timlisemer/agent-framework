import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";
import { PLAN_MODE_CONTEXT_RULE_POLICY } from "./policies.js";

export const planModeContextRule: PreToolRule = {
  name: "plan-mode-context",
  displayName: "Plan Mode Context",
  priority: 76,
  appealable: false,
  usesLlm: true,
  evaluationAgent: RULE_GATE_AGENT,
  version: "1",
  configuration: PLAN_MODE_CONTEXT_RULE_POLICY,
  promptSection: `If "PLAN MODE ACTIVE" appears in context, the user's intent is exploration/planning. Read-only tools should be APPROVED. Edits to the active adapter's plan files, host instruction files, and memory files are also APPROVED - those are the planner's legitimate write targets in plan mode. Do not deny based on "user wants implementation."`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.planModeCtx.active) return null;
    return { llmContext: ctx.planModeCtx.contextString };
  },
};
