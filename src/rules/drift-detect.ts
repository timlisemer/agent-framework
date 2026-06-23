import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import {
  describesMultiRegionEditIntent,
  detectDrift,
  extractDriftTargets,
} from "../utils/drift-detector.js";
import { isEditToolName } from "../utils/edit-tools.js";
import { readToolLogEntries } from "../utils/session-store.js";

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
    // count toward the warning threshold — drift counters reset per turn.
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
      },
    );
    if (drift.detected) {
      return { fastDeny: drift.reason };
    }

    // Allow-path: advance allowedSinceLevelChange for warned/final-warned
    // targets so the "3 free" / "1 free" bypass windows count down.
    const targets = extractDriftTargets(ctx.toolInput);
    if (targets.length > 0 && isEditToolName(ctx.toolName)) {
      const updates = Object.fromEntries(targets.flatMap((target) => {
        const state = ctx.state.driftState?.[target];
        if (state && state.level > 0 && state.level < 3) {
          return [[
            target,
            {
              level: state.level,
              allowedSinceLevelChange: state.allowedSinceLevelChange + 1,
            },
          ]];
        }
        return [];
      }));
      if (Object.keys(updates).length > 0) {
        await ctx.stateManager.update((s) => ({
          ...s,
          driftState: {
            ...(s.driftState ?? {}),
            ...updates,
          },
        }));
      }
    }

    return null;
  },

  async onDenialConfirmed(ctx: RuleContext, reason: string): Promise<void> {
    const targets = extractDriftTargets(ctx.toolInput);
    if (targets.length === 0 || !isEditToolName(ctx.toolName)) return;

    // Only graduate the loop/thrashing branch. All three drift messages share
    // the substring `edits to "` (level 0/1/2/3 emissions in drift-detector.ts).
    // Workaround-escalation denials use a different shape and are excluded.
    if (!/edits to "/.test(reason)) return;

    await ctx.stateManager.update((s) => {
      const nextEntries = Object.fromEntries(targets.map((target) => {
        const prior = s.driftState?.[target] ?? { level: 0 as const, allowedSinceLevelChange: 0 };
        const nextLevel = Math.min(prior.level + 1, 3) as 0 | 1 | 2 | 3;
        return [target, { level: nextLevel, allowedSinceLevelChange: 0 }];
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
