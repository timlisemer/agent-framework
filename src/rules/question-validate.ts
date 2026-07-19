import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgent } from "../utils/agent-runner.js";
import {
  readTranscriptExact,
  formatTranscriptResult,
} from "../utils/transcript.js";
import { QUESTION_VALIDATE_COUNTS } from "../utils/transcript-presets.js";
import { buildQuestionValidateAgent } from "../utils/agent-configs.js";
import {
  formatAskUserQuestionsForValidation,
  normalizeAskUserQuestions,
} from "../utils/ask-user-question.js";
import { isCancellationError } from "../utils/cancellation.js";
import { QUESTION_VALIDATE_RULE_POLICY } from "./policies.js";

export const questionValidateRule: PreToolRule = {
  name: "question-validate",
  displayName: "Question Validate",
  priority: 30,
  appealable: false,
  usesLlm: true,
  get evaluationAgent() {
    return buildQuestionValidateAgent();
  },
  version: "1",
  configuration: QUESTION_VALIDATE_RULE_POLICY,
  events: ["PreToolUse"],
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== QUESTION_VALIDATE_RULE_POLICY.toolName) return null;

    if (normalizeAskUserQuestions(ctx.toolInput).length === 0) {
      return null;
    }

    const tx = await readTranscriptExact(
      ctx.transcriptPath,
      QUESTION_VALIDATE_COUNTS,
    ).catch(() => null);
    const conv = tx ? formatTranscriptResult(tx) : "";
    if (!conv.trim()) return null;

    const formattedQuestions = formatAskUserQuestionsForValidation(
      ctx.toolInput,
    );

    const result = await runAgent(
      { ...questionValidateRule.evaluationAgent!, workingDir: ctx.projectDir },
      {
        prompt: "Check if these questions are appropriate to show to the user.",
        context: `QUESTIONS:\n${formattedQuestions}\n\nCONVERSATION AND TOOL HISTORY:\n${conv}`,
      },
      { signal: ctx.signal },
    ).catch((error: unknown) => {
      if (isCancellationError(error)) throw error;
      return { output: "ALLOW", success: false };
    });

    const text = result.output.trim();
    if (text.startsWith("BLOCK:")) {
      return { fastDeny: text.slice(6).trim() };
    }
    return null;
  },
};
