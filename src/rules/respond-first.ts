import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { CONFIRMATION_PATTERN } from "./utils.js";
import {
  readTranscriptExact,
  currentTurnAssistantState,
} from "../utils/transcript.js";
import {
  INACTION_COMPLAINT_RE,
  EXPLICIT_PROHIBITION_RE,
} from "../utils/prediction-types.js";

// Deterministic rule: AI must produce text in the current turn before calling
// tools. Carve-outs are narrow and explicit (slash commands, confirmation
// patterns, inaction-complaint intent). Race-awareness for Claude Code's
// split-message writes lives in currentTurnAssistantState
// (src/utils/transcript.ts), not here.

export const respondFirstRule: PreToolRule = {
  name: "respond-first",
  displayName: "Respond First",
  priority: 5,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent || ctx.state.respondFirstChecked) {
      return null;
    }

    if (ctx.toolName === "AskUserQuestion" || ctx.toolName === "ExitPlanMode") {
      await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
      return null;
    }

    const rfResult = await readTranscriptExact(ctx.transcriptPath, {
      counts: { user: 1 },
      excludeSlashCommandPrompts: true,
      includeSlashCommandContext: true,
    });
    const lastUser = rfResult.user.length > 0 ? rfResult.user[0] : null;

    if (
      !lastUser ||
      rfResult.newestUserWasSlashCommand ||
      CONFIRMATION_PATTERN.test(lastUser.content)
    ) {
      await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
      return null;
    }

    // Inaction-complaint short-circuit: when the user's last message
    // demanded the AI quit stalling and proceed (per the prediction's
    // intent morphology — see prediction-types INACTION_COMPLAINT_RE),
    // forcing a text reply BEFORE the tool call is exactly the deflection
    // the user was complaining about. Skip the respond-first check.
    //
    // Guard with EXPLICIT_PROHIBITION_RE on the user's actual message:
    // a categorical "no tools / freeze / hands off" still wins.
    const pred = ctx.state.currentPrediction;
    if (pred) {
      const userSaidProhibition = EXPLICIT_PROHIBITION_RE.test(
        lastUser.content,
      );
      if (
        !userSaidProhibition &&
        INACTION_COMPLAINT_RE.test(pred.intent)
      ) {
        await ctx.stateManager.update((s) => ({
          ...s,
          respondFirstChecked: true,
        }));
        return null;
      }
    }

    const state = await currentTurnAssistantState(ctx.transcriptPath, ctx.toolUseId);
    await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));

    switch (state.kind) {
      case "responded":
        return null;
      case "silent":
        return {
          fastDeny: `You must respond to the user with text before calling tools. The user said: "${lastUser.content.slice(0, 150)}". Respond with text first, then proceed with tool calls.`,
        };
      case "no-current-turn":
        return null;
    }
  },
};
