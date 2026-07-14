import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { detectIntentFulfillment, formatIntentFulfillment } from "../utils/intent-fulfillment.js";

export const intentFulfillmentContextRule: PreToolRule = {
  name: "intent-fulfillment-context",
  displayName: "Intent Fulfillment Context",
  priority: 67,
  appealable: false,
  usesLlm: true,
  promptSection: `If "INTENT FULFILLMENT" appears in context, the user's stated request from the cached PREDICTIONS block has already been served by completed prior tool calls listed in that block. The cached intent text is from BEFORE that work completed - treat it as historical context, not active demand. The session has progressed to a new step; the appropriate toolset has shifted. APPROVE tools that fit the new step. Do NOT DENY merely because the firing tool is not literally named in the (now-fulfilled) intent text.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const prediction = ctx.state.currentPrediction;
    if (!prediction) return null;
    const tail = readToolLogEntries(ctx.sessionDir, 50);
    const signal = detectIntentFulfillment(prediction, tail);
    if (!signal) return null;
    return { llmContext: formatIntentFulfillment(signal) };
  },
};
