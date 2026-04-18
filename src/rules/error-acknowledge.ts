import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { readTranscriptExact } from "../utils/transcript.js";

export const errorAcknowledgeRule: PreToolRule = {
  name: "error-acknowledge",
  displayName: "Error Ack",
  priority: 50,
  appealable: true,
  usesLlm: true,
  promptSection: `Check if the AI acknowledged a previous tool denial before proceeding.

APPROVE if:
- The new tool call genuinely fixes or addresses the previous error
- The AI acknowledged the error in text and is taking appropriate action
- The new tool call is a corrected retry with different parameters

DENY if:
- The error was ignored -- AI proceeded with unrelated work
- AI text exists but does not address the error
- AI is retrying the exact same operation without changes

NO error can be ignored. Every denial must be acknowledged before moving on.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) {
      return null;
    }

    // Read recent tool log for denials
    const recentLog = readToolLogEntries(ctx.sessionDir, 5);
    const recentDenial = recentLog.find((entry) => entry.status === "denied");

    if (!recentDenial) {
      return null;
    }

    // Check if this is a corrected retry (different parameters for same tool)
    if (recentDenial.tool === ctx.toolName) {
      const currentInput = JSON.stringify(ctx.toolInput).slice(0, 200);
      const denialPath = recentDenial.path || "";
      const denialCmd = recentDenial.cmd || "";
      // If the tool is the same but input differs, it's likely a corrected retry
      if (!currentInput.includes(denialPath) && !currentInput.includes(denialCmd)) {
        return null;
      }
    }

    // Read transcript to check for assistant acknowledgment
    const rfResult = await readTranscriptExact(ctx.transcriptPath, {
      counts: { user: 0, assistant: 1 },
    });
    const lastAssistant = rfResult.assistant.length > 0 ? rfResult.assistant[0] : null;

    if (!lastAssistant) {
      // No assistant text after denial -- different tool means ignoring
      if (recentDenial.tool !== ctx.toolName) {
        return { fastDeny: `Previous tool "${recentDenial.tool}" was denied: ${recentDenial.reason}. You must acknowledge the error before proceeding with a different tool.` };
      }
      return null;
    }

    // Assistant text exists -- check if it's clearly unrelated
    if (recentDenial.tool !== ctx.toolName) {
      const denialKeywords = (recentDenial.reason || "").toLowerCase().split(/\s+/).slice(0, 5);
      const assistantLower = lastAssistant.content.toLowerCase();
      const acknowledgesError = denialKeywords.some((kw) => kw.length > 3 && assistantLower.includes(kw));

      if (!acknowledgesError) {
        // Ambiguous -- use LLM to decide
        return {
          llmContext: `PREVIOUS DENIAL:\nTool: ${recentDenial.tool}\nReason: ${recentDenial.reason}\n\nASSISTANT TEXT AFTER DENIAL:\n${lastAssistant.content.slice(0, 300)}\n\nCURRENT TOOL CALL:\n${ctx.toolName} with ${JSON.stringify(ctx.toolInput).slice(0, 200)}`,
        };
      }
    }

    return null;
  },
};
