import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { detectDrift } from "../utils/drift-detector.js";
import { readToolLogEntries } from "../utils/session-store.js";

export const driftDetectRule: PreToolRule = {
  name: "drift-block",
  displayName: "Drift Detect",
  priority: 40,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) {
      return null;
    }

    const recentLog = readToolLogEntries(ctx.sessionDir, 10);
    const drift = detectDrift(ctx.toolName, ctx.toolInput, recentLog);
    if (drift.detected) {
      return { fastDeny: drift.reason };
    }

    return null;
  },
};
