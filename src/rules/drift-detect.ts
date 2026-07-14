import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  describesMultiRegionEditIntent,
  detectDrift,
  extractDriftTargets,
} from "../utils/drift-detector.js";
import { isEditToolName } from "../utils/edit-tools.js";
import { readToolLogEntries, type DriftTargetState } from "../utils/session-store.js";

export const driftDetectRule: PreToolRule = {
  name: "drift-block",
  displayName: "Drift Detect",
  priority: 40,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Scope drift counting to the current user turn. Every UserPromptSubmit
    // bumps lastUserMessageTimestamp, so prior-turn allowed edits no longer
    // count toward the warning threshold - drift counters reset per turn.
    const sinceTs = ctx.state.lastUserMessageTimestamp ?? 0;
    const recentLog = readToolLogEntries(ctx.sessionDir, 50)
      .filter((e) => e.ts >= sinceTs);
    const drift = detectDrift(
      ctx.toolName,
      ctx.toolInput,
      recentLog,
      ctx.state.driftState,
      {
        allowMultiRegionEditRepetition: isExplicitMultiRegionEdit(ctx),
        driftReductionCredits: ctx.state.driftReductionCredits ?? {},
      },
    );
    if (drift.detected) {
      return { fastDeny: drift.reason };
    }

    return null;
  },

  async onDenialConfirmed(ctx: RuleContext, reason: string): Promise<void> {
    const targets = extractDriftTargets(ctx.toolInput);
    if (targets.length === 0 || !isEditToolName(ctx.toolName)) return;

    // Only graduate the loop branch. Drift messages share
    // the substring `edits to "` (emissions in drift-detector.ts).
    // Workaround-escalation denials use a different shape and are excluded.
    if (!/edits to "/.test(reason)) return;

    await ctx.stateManager.update((s) => {
      const nextEntries: Record<string, DriftTargetState> = Object.fromEntries(targets.map((target) => {
        const prior = s.driftState?.[target] ?? { level: 0 as const };
        const nextLevel: DriftTargetState["level"] = prior.level === 0 ? 1 : 2;
        return [target, { level: nextLevel }];
      }));
      return {
        ...s,
        driftState: {
          ...(s.driftState ?? {}),
          ...nextEntries,
        },
      };
    });
  },
};

function isExplicitMultiRegionEdit(ctx: RuleContext): boolean {
  const prediction = ctx.state.currentPrediction;
  const text = [
    prediction?.intent ?? "",
    prediction?.userMessageFull ?? "",
    prediction?.userMessageSnippet ?? "",
    ctx.latestUserTurn?.logicText ?? "",
    ctx.latestUserMessage ?? "",
  ].join("\n");
  return describesMultiRegionEditIntent(text);
}
