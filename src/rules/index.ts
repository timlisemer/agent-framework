import type { PreToolRule } from "./types.js";
import { respondFirstRule } from "./respond-first.js";
import { planModeBlockRule } from "./plan-mode-block.js";
import { backgroundAgentBlockRule } from "./background-agent-block.js";
import { questionValidateRule } from "./question-validate.js";
import { forceCheckRequiredRule } from "./force-check-required.js";
import { blacklistRule } from "./blacklist.js";
import { predictionQuestionJudgeRule } from "./prediction-question-judge.js";
import { predictionBlockRule } from "./prediction-block.js";
import { createPlanfileAllowRule } from "./create-planfile-allow.js";
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
import { validateIntentRule } from "./validate-intent.js";
import { sentimentRule } from "./sentiment.js";
import { responseAlignStopRule } from "./response-align-stop.js";

export type { PreToolRule, RuleContext, RuleCheckResult, HookEvent } from "./types.js";
export { evaluateRules, evaluateRulesForUserPromptSubmit, evaluateRulesForStop } from "./evaluator.js";

export const ALL_RULES: PreToolRule[] = [
  respondFirstRule,
  planModeBlockRule,
  backgroundAgentBlockRule,
  questionValidateRule,
  forceCheckRequiredRule,
  blacklistRule,
  predictionQuestionJudgeRule,
  predictionBlockRule,
  createPlanfileAllowRule,
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
  validateIntentRule,
  sentimentRule,
  responseAlignStopRule,
].sort((a, b) => a.priority - b.priority);
