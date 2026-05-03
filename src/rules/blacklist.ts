import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  detectWorkaroundPattern,
  getBlacklistHighlights,
} from "../utils/command-patterns.js";
import { MAX_SIMILAR_DENIALS, recordDenial } from "../utils/denial-cache.js";

export const blacklistRule: PreToolRule = {
  name: "blacklist",
  displayName: "Blacklist",
  priority: 34,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const highlights = getBlacklistHighlights(ctx.toolName, ctx.toolInput, ctx.projectDir);
    if (highlights.length === 0) return null;

    const reason = highlights
      .map((h) => h.replace(/^\[BLACKLIST: [^\]]+\]\s*/, ""))
      .join(". ");
    return { fastDeny: reason };
  },

  async onDenialConfirmed(ctx: RuleContext, _reason: string): Promise<void> {
    const workaroundCategory = detectWorkaroundPattern(ctx.toolName, ctx.toolInput);
    if (!workaroundCategory) return;

    const count = await recordDenial(workaroundCategory);
    if (count >= MAX_SIMILAR_DENIALS) {
      // The evaluator owns the rendered denial text; the count is retained
      // for repeated-workaround state and future policy tightening.
    }

    await ctx.stateManager.update((s) => ({ ...s, forceCheckPending: true }));
  },
};
