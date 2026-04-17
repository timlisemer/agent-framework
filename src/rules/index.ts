import type { PreToolRule } from "./types.js";
import { respondFirstRule } from "./respond-first.js";
import { lowRiskRule } from "./low-risk.js";
import { planModeBlockRule } from "./plan-mode-block.js";
import { subagentRule } from "./subagent.js";
import { questionValidateRule } from "./question-validate.js";
import { forceCheckRequiredRule } from "./force-check-required.js";
import { predictionBlockRule } from "./prediction-block.js";
import { driftDetectRule } from "./drift-detect.js";
import { correctionRule } from "./correction.js";
import { errorAcknowledgeRule } from "./error-acknowledge.js";
import { trustedPathRule } from "./trusted-path.js";
import { editIntentRule } from "./edit-intent.js";
import { styleDriftRule } from "./style-drift.js";
import { gateRule } from "./gate.js";
import { toolApproveRule } from "./tool-approve.js";

export type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
export { evaluateRules } from "./evaluator.js";

export const ALL_RULES: PreToolRule[] = [
  respondFirstRule,
  lowRiskRule,
  planModeBlockRule,
  subagentRule,
  questionValidateRule,
  forceCheckRequiredRule,
  predictionBlockRule,
  driftDetectRule,
  correctionRule,
  errorAcknowledgeRule,
  trustedPathRule,
  editIntentRule,
  styleDriftRule,
  gateRule,
  toolApproveRule,
].sort((a, b) => a.priority - b.priority);
