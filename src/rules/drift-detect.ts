import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { detectDrift } from "../utils/drift-detector.js";
import { getSummaryPath, readSection, readToolLogEntries } from "../utils/summary-cache.js";

export const driftDetectRule: PreToolRule = {
  name: "drift-block",
  displayName: "Drift Detect",
  priority: 40,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.useSyncPipeline || ctx.subagent) {
      return null;
    }

    let userIntent = "";
    let misalignments = "";
    try {
      const summaryPath = getSummaryPath(ctx.transcriptPath);
      userIntent = await readSection(summaryPath, "User Intent");
      misalignments = await readSection(summaryPath, "Flagged Misalignments");
    } catch {
      // No summary yet
    }

    const recentLog = readToolLogEntries(ctx.sessionDir, 10);
    const drift = detectDrift(ctx.toolName, ctx.toolInput, userIntent, misalignments, recentLog);
    if (drift.detected && drift.severity === "block") {
      return { fastDeny: drift.reason };
    }

    return null;
  },
};
