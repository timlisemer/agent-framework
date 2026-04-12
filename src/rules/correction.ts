import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { getUnconsumedCorrections, consumeCorrections } from "../utils/correction-cache.js";

export const correctionRule: PreToolRule = {
  name: "correction",
  displayName: "Correction",
  priority: 45,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const isSubagentLauncher = ctx.toolName === "Agent" || ctx.toolName === "Task";
    if (ctx.subagent || isSubagentLauncher) {
      return null;
    }

    const corrections = await getUnconsumedCorrections(ctx.sessionDir);
    const relevantCorrection = corrections.find((c) => c.toolName === ctx.toolName);
    if (relevantCorrection) {
      await consumeCorrections(ctx.sessionDir);
      return { fastDeny: relevantCorrection.reason };
    }

    return null;
  },
};
