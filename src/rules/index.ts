import type { PreToolRule } from "./types.js";
import { respondFirstRule } from "./respond-first.js";
import { lowRiskRule } from "./low-risk.js";
import { planModeBlockRule } from "./plan-mode-block.js";
import { subagentRule } from "./subagent.js";
import { backgroundAgentBlockRule } from "./background-agent-block.js";
import { questionValidateRule } from "./question-validate.js";
import { forceCheckRequiredRule } from "./force-check-required.js";
import { predictionQuestionJudgeRule } from "./prediction-question-judge.js";
import { predictionBlockRule } from "./prediction-block.js";
import { driftDetectRule } from "./drift-detect.js";
import { errorAcknowledgeRule } from "./error-acknowledge.js";
import { trustedPathRule } from "./trusted-path.js";
import { editIntentRule } from "./edit-intent.js";
import { styleDriftRule } from "./style-drift.js";
import { predictionContextRule } from "./prediction-context.js";
import { recentMessagesRule } from "./recent-messages.js";
import { reasoningHistoryRule } from "./reasoning-history.js";
import { editIntentContextRule } from "./edit-intent-context.js";
import { planModeContextRule } from "./plan-mode-context.js";
import { intentFulfillmentContextRule } from "./intent-fulfillment-context.js";
import { planModeStepContextRule } from "./plan-mode-step-context.js";
import { toolApproveRule } from "./tool-approve.js";

export type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
export { evaluateRules } from "./evaluator.js";

export const ALL_RULES: PreToolRule[] = [
  respondFirstRule,
  lowRiskRule,
  planModeBlockRule,
  subagentRule,
  backgroundAgentBlockRule,
  questionValidateRule,
  forceCheckRequiredRule,
  predictionQuestionJudgeRule,
  predictionBlockRule,
  driftDetectRule,
  errorAcknowledgeRule,
  trustedPathRule,
  editIntentRule,
  styleDriftRule,
  predictionContextRule,
  recentMessagesRule,
  reasoningHistoryRule,
  editIntentContextRule,
  planModeContextRule,
  intentFulfillmentContextRule,
  planModeStepContextRule,
  toolApproveRule,
].sort((a, b) => a.priority - b.priority);
