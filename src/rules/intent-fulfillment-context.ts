import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  detectRecentIntentFulfillment,
  formatIntentFulfillment,
} from "../utils/intent-fulfillment.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";
import { INTENT_FULFILLMENT_CONTEXT_RULE_POLICY } from "./policies.js";

export const intentFulfillmentContextRule: PreToolRule = {
  name: "intent-fulfillment-context",
  displayName: "Intent Fulfillment Context",
  priority: 67,
  appealable: false,
  usesLlm: true,
  evaluationAgent: RULE_GATE_AGENT,
  version: "1",
  configuration: INTENT_FULFILLMENT_CONTEXT_RULE_POLICY,
  promptSection: `If "INTENT FULFILLMENT" appears in context, the user's stated request from the cached PREDICTIONS block has already been served by completed prior tool calls listed in that block. The cached intent text is from BEFORE that work completed - treat it as historical context, not active demand. The session has progressed to a new step; the appropriate toolset has shifted. APPROVE tools that fit the new step. Do NOT DENY merely because the firing tool is not literally named in the (now-fulfilled) intent text.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const prediction = ctx.state.currentPrediction;
    if (!prediction) return null;
    const signal = detectRecentIntentFulfillment(
      prediction,
      ctx.toolHistory ?? [],
    );
    if (!signal) return null;
    return { llmContext: formatIntentFulfillment(signal) };
  },
};
