import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readTranscriptExact } from "../utils/transcript.js";

export const recentMessagesRule: PreToolRule = {
  name: "recent-messages",
  displayName: "Recent Messages",
  priority: 70,
  appealable: false,
  usesLlm: true,
  promptSection: `When RECENT USER MESSAGES contains 2+ entries, the newest may be a clarification or side-task nested under an earlier request. APPROVE a tool call that serves ANY listed message; only DENY if every message contradicts the tool call. When direct instructions conflict, the newest direct user instruction wins, including newer edit authorization over older no-edit/chat-only instructions.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const oldestFirst = ctx.recentUserMessages && ctx.recentUserMessages.length > 0
      ? ctx.recentUserMessages.map((content, index) => ({ role: "user" as const, content, index }))
      : (await readTranscriptExact(ctx.transcriptPath, {
          counts: { user: { count: 3 } },
          excludeSlashCommandPrompts: true,
        }).catch(() => null))?.user.slice().reverse() ?? [];
    if (oldestFirst.length < 2) return null;
    const block =
      "RECENT USER MESSAGES (oldest to newest):\n" +
      oldestFirst.map((m, i) => {
        const label = i === oldestFirst.length - 1 ? " LATEST/NEWEST" : "";
        return `[${i}${label}] ${String(m.content)}`;
      }).join("\n");
    return { llmContext: block };
  },
};
