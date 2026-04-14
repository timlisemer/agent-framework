import * as fs from "fs";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { CONFIRMATION_PATTERN } from "./utils.js";
import { readTranscriptExact } from "../utils/transcript.js";
import { RESPOND_FIRST_QUALITY_AGENT } from "../utils/agent-configs.js";

// UNIFIED PATTERN: This rule uses { llmContext } to contribute to the shared
// RULE_GATE_AGENT call, matching error-acknowledge/gate/tool-approve.
//
// Previously, this rule ran its own dedicated LLM call via
// RESPOND_FIRST_QUALITY_AGENT and returned fastDeny/null directly. That
// approach used a more specific prompt and may have produced better quality
// decisions. If users ever report problems with respond-first quality
// (false denials, approving vague responses), REVERT TO THE DEDICATED LLM
// PATTERN FIRST — the old implementation is preserved in git history.
//
// NOTE: There are currently 3 patterns for LLM-backed checks:
// 1. Unified llmContext (respond-first, error-acknowledge, gate, tool-approve)
//    — contributes context to a single shared RULE_GATE_AGENT haiku call
// 2. Self-contained LLM (question-validate, style-drift)
//    — runs its own dedicated LLM call, returns fastDeny/fastAllow
// 3. Outside rules entirely (plan-validate, claude-md-validate)
//    — called directly in main() after all rules pass, not PreToolRule objects
//
// A future refactor should consider unifying all 3 patterns into one system
// where each check declares its LLM needs and the framework handles routing.

export const respondFirstRule: PreToolRule = {
  name: "respond-first",
  displayName: "Respond First",
  priority: 5,
  appealable: false,
  usesLlm: true,
  promptSection: RESPOND_FIRST_QUALITY_AGENT.systemPrompt,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent || ctx.state.respondFirstChecked) {
      return null;
    }

    if (ctx.toolName === "AskUserQuestion" || ctx.toolName === "ExitPlanMode") {
      // Exempt tools -- mark checked and skip
      await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
      return null;
    }

    const rfResult = await readTranscriptExact(ctx.transcriptPath, {
      counts: { user: 1, assistant: 1 },
    });

    const lastUser = rfResult.user.length > 0 ? rfResult.user[0] : null;
    const lastAssistant = rfResult.assistant.length > 0 ? rfResult.assistant[0] : null;

    if (lastUser && !CONFIRMATION_PATTERN.test(lastUser.content)) {
      if (!lastAssistant) {
        // readTranscriptExact is contractually forbidden from returning a
        // prior-turn assistant under lastAssistant (see the
        // firstUserSeenIndex boundary in src/utils/transcript.ts). So
        // lastAssistant === null means the scan has no current-turn
        // assistant text to report.
        //
        // That can mean two different things, and they have opposite
        // correct actions:
        //
        // 1. Claude Code has already flushed this turn's tool_use entry
        //    (so the whole current turn, including thinking and any text
        //    block, is in the transcript) and there is still no text ->
        //    the assistant went straight to tools, this is a real
        //    violation and we must fastDeny.
        //
        // 2. Claude Code has NOT yet flushed this turn's tool_use entry
        //    (so any text block that exists is also not yet visible) ->
        //    we cannot judge; skip.
        //
        // The objective marker for which case we're in is whether the
        // specific tool_use_id this hook is firing for already appears in
        // the raw transcript file.
        const raw = await fs.promises.readFile(ctx.transcriptPath, "utf-8");
        await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
        if (raw.includes(ctx.toolUseId)) {
          return {
            fastDeny: `You must respond to the user with text before calling tools. The user said: "${lastUser.content.slice(0, 150)}". Respond with text first, then proceed with tool calls.`,
          };
        }
        return null;
      } else if (lastAssistant.index > lastUser.index) {
        // Assistant message exists after user -- check quality
        if (lastAssistant.content.trim().length === 0) {
          // Empty assistant text -- deterministic deny, no LLM needed
          await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
          return {
            fastDeny: `You must respond to the user with text before calling tools. The user said: "${lastUser.content.slice(0, 150)}". Respond with text first, then proceed with tool calls.`,
          };
        }

        // Non-empty assistant text -- contribute to shared rule-gate LLM call
        await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
        return {
          llmContext: `USER MESSAGE:\n${lastUser.content.slice(0, 500)}\n\nASSISTANT RESPONSE:\n${lastAssistant.content.slice(0, 500)}`,
        };
      }
    }

    // Passed checks (or exempt tool or confirmation or no user message) -- skip for rest of turn
    await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
    return null;
  },
};
