import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readTranscriptExact } from "../utils/transcript.js";

export const recentMessagesRule: PreToolRule = {
  name: "recent-messages",
  displayName: "Recent Messages",
  priority: 70,
  appealable: false,
  usesLlm: true,
  promptSection: `When RECENT USER MESSAGES contains 2+ entries, the newest may be a clarification or side-task nested under an earlier request. APPROVE a tool call that serves ANY listed message; only DENY if every message contradicts the tool call. Treat the latest as a replacement intent only when it explicitly retracts a prior task ("forget that", "never mind", "cancel that") or names a fundamentally different top-level task.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const tx = await readTranscriptExact(ctx.transcriptPath, {
      counts: { user: 3 },
      excludeSlashCommandPrompts: true,
    }).catch(() => null);
    if (!tx || tx.user.length < 2) return null;
    const oldestFirst = tx.user.slice().reverse();
    const block =
      "RECENT USER MESSAGES (oldest to newest):\n" +
      oldestFirst.map((m, i) => `[${i}] ${String(m.content)}`).join("\n");
    return { llmContext: block };
  },
};
