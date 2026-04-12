import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { checkQuestionValidity } from "../agents/hooks/question-validate.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { QUESTION_VALIDATE_COUNTS } from "../utils/transcript-presets.js";

export const questionValidateRule: PreToolRule = {
  name: "question-validate",
  displayName: "Question Validate",
  priority: 30,
  appealable: false,
  usesLlm: true,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== "AskUserQuestion") {
      return null;
    }

    const questionTranscript = await readTranscriptExact(ctx.transcriptPath, QUESTION_VALIDATE_COUNTS);
    const questionContext = formatTranscriptResult(questionTranscript);

    const validation = await checkQuestionValidity(
      ctx.toolInput,
      questionContext,
      ctx.transcriptPath,
      ctx.projectDir,
      "PreToolUse"
    );

    if (!validation.approved) {
      const appeal = await appealHelper(
        ctx.toolName,
        `AskUserQuestion: ${JSON.stringify(ctx.toolInput).slice(0, 200)}`,
        questionContext,
        validation.reason || "Question validation failed",
        ctx.projectDir,
        "PreToolUse",
        `question-validate blocked: ${validation.reason}`
      );

      if (!appeal.overturned) {
        return { fastDeny: validation.reason || "Question validation failed - show referenced content first" };
      }
    }

    // Question validated or appeal overturned - allow
    return { fastAllow: "Question validated" };
  },
};
