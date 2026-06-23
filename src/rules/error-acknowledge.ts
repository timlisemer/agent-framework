import * as path from "path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { readTranscriptExact } from "../utils/transcript.js";
import { stringifyToolInput } from "../utils/prediction-types.js";
import { isForceCheckSatisfyingMcpToolName } from "../utils/force-check-tools.js";
import { isEditToolName } from "../utils/edit-tools.js";
import { extractFilePaths } from "./utils.js";
import { summarizeRuleToolCall } from "./tool-call-context.js";

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
    // Read recent tool log for denials. A later successful framework
    // check/commit/confirm/fullconfirm/validate_implementation satisfies older workaround denials, matching
    // pre-tool-use's forceCheckPending clear semantics.
    const recentLog = readToolLogEntries(ctx.sessionDir, 5);
    let recentDenial: ReturnType<typeof readToolLogEntries>[number] | undefined;
    for (let i = recentLog.length - 1; i >= 0; i--) {
      const entry = recentLog[i];
      if (entry.status === "allowed" && isForceCheckSatisfyingMcpToolName(entry.tool)) {
        break;
      }
      if (entry.status === "denied") {
        recentDenial = entry;
        break;
      }
    }

    if (!recentDenial) {
      return null;
    }

    // Same-target Edit-class consolidation. When a prior denial was on file F
    // using an Edit-class tool AND the current call is also an Edit-class
    // tool on file F, this is by construction a corrective action -- drift
    // Warnings teach "consolidate to one Write," and same-tool retries on
    // the same path are the canonical recovery from edit failures. drift-detect
    // independently governs the bypass-window count, so error-acknowledge
    // must not double-block.
    if (
      isEditToolName(recentDenial.tool) &&
      isEditToolName(ctx.toolName) &&
      (recentDenial.paths?.length || recentDenial.path)
    ) {
      const deniedPaths = recentDenial.paths?.length ? recentDenial.paths : [recentDenial.path!];
      const currentPaths = extractFilePaths(ctx.toolName, ctx.toolInput);
      if (currentPaths.some((currentPath) =>
        deniedPaths.some((deniedPath) => path.resolve(currentPath) === path.resolve(deniedPath))
      )) {
        return null;
      }
    }

    // Check if this is a corrected retry (different parameters for same tool)
    if (recentDenial.tool === ctx.toolName) {
      const currentInput = stringifyToolInput(ctx.toolInput);
      const denialPaths = recentDenial.paths?.length ? recentDenial.paths : [recentDenial.path || ""];
      const denialCmd = recentDenial.cmd || "";
      // If the tool is the same but input differs, it's likely a corrected retry
      if (!denialPaths.some((denialPath) => denialPath && currentInput.includes(denialPath)) && !currentInput.includes(denialCmd)) {
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
        const toolDescription = summarizeRuleToolCall(ctx);
        // Ambiguous -- use LLM to decide
        return {
          llmContext: `PREVIOUS DENIAL:\nTool: ${recentDenial.tool}\nReason: ${recentDenial.reason}\n\nASSISTANT TEXT AFTER DENIAL:\n${lastAssistant.content.slice(0, 300)}\n\nCURRENT TOOL CALL:\n${toolDescription}`,
        };
      }
    }

    return null;
  },
};
