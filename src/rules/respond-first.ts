import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { CONFIRMATION_PATTERN } from "./utils.js";
import { readTranscriptExact } from "../utils/transcript.js";
import { RESPOND_FIRST_QUALITY_AGENT } from "../utils/agent-configs.js";

// Slash commands from claude/commands/*.md are injected into the transcript
// as synthetic user messages tagged with <command-name>/foo</command-name>.
// Those "messages" never come from a human, so requiring the assistant to
// respond with text before calling tools produces false positives. Exempt any
// user message that resolves to a real command file in claude/commands/.
let cachedCommandNames: Set<string> | null = null;
function getCommandNames(): Set<string> {
  if (cachedCommandNames) return cachedCommandNames;
  const root = process.env.AGENT_FRAMEWORK_ROOT;
  if (!root) {
    cachedCommandNames = new Set();
    return cachedCommandNames;
  }
  try {
    const entries = readdirSync(join(root, "claude", "commands"));
    cachedCommandNames = new Set(
      entries.filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)),
    );
  } catch {
    cachedCommandNames = new Set();
  }
  return cachedCommandNames;
}

function isSlashCommandInvocation(userContent: string): boolean {
  const match = userContent.match(/<command-name>\/([^<\s]+)<\/command-name>/);
  if (!match) return false;
  return getCommandNames().has(match[1]);
}

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

    if (
      lastUser &&
      !CONFIRMATION_PATTERN.test(lastUser.content) &&
      !isSlashCommandInvocation(lastUser.content)
    ) {
      if (!lastAssistant) {
        // readTranscriptExact is contractually forbidden from returning a
        // prior-turn assistant under lastAssistant (see the
        // firstUserSeenIndex boundary in src/utils/transcript.ts). So
        // lastAssistant === null means the scan has no data about the
        // current turn at all -- not evidence of a violation. Mark checked
        // so we don't rescan on every tool call in this turn and let the
        // other rules decide.
        await ctx.stateManager.update((s) => ({ ...s, respondFirstChecked: true }));
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
