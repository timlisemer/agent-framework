import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  classifyBashCommand,
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
    if (ctx.toolName !== "Bash") return;
    const command = (ctx.toolInput as { command?: string }).command ?? "";
    const classification = classifyBashCommand(command, ctx.projectDir);
    if (classification.riskClass !== "high-risk-workaround" || !classification.workaroundCategory) return;

    const count = await recordDenial(classification.workaroundCategory);
    if (count >= MAX_SIMILAR_DENIALS) {
      // The evaluator owns the rendered denial text; the count is retained
      // for repeated-workaround state and future policy tightening.
    }

    await ctx.stateManager.update((s) => ({ ...s, forceCheckPending: true }));
  },
};
