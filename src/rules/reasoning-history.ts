import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";

export const reasoningHistoryRule: PreToolRule = {
  name: "reasoning-history",
  displayName: "Reasoning History",
  priority: 72,
  appealable: false,
  usesLlm: true,
  promptSection: `GATE REASONING HISTORY shows prior gate decisions on this session, with optional NOTE fields about scope/pattern concerns. Treat NOTEs as scope hints (e.g. "watch for drift outside src/auth/"). Do not auto-DENY just because a prior call had a NOTE; deny only when this call clearly violates the noted concern.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const gateReasoning = ctx.reasoningHistory ?? "";
    if (!gateReasoning) return null;
    return { llmContext: `GATE REASONING HISTORY:\n${gateReasoning}` };
  },
};
