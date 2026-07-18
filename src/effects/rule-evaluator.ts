import {
  ALL_RULES,
  evaluateRules,
  evaluateRulesForStop,
  evaluateRulesForUserPromptSubmit,
} from "../rules/index.js";
import type {
  EvaluatorResult,
  RuleTraceOptions,
  StopEvaluatorResult,
} from "../rules/evaluator.js";
import type { PreToolRule, RuleContext } from "../rules/types.js";
import { validateIntentRule } from "../rules/validate-intent.js";

/** Concrete Agent Framework rule adapter used by the injected Scenario effect executor. */
export function runtimeRuleRegistry(): PreToolRule[] {
  return [...ALL_RULES];
}

export function evaluateRuntimePreToolRules(
  rules: PreToolRule[],
  context: RuleContext,
  hookName: string,
  traceOptions?: RuleTraceOptions,
): Promise<EvaluatorResult | null> {
  return evaluateRules(rules, context, hookName, traceOptions);
}

export function evaluateRuntimeUserPromptRules(
  rules: PreToolRule[],
  context: RuleContext,
  traceOptions?: RuleTraceOptions,
): Promise<void> {
  return evaluateRulesForUserPromptSubmit(rules, context, traceOptions);
}

export function evaluateRuntimeStopRules(
  rules: PreToolRule[],
  context: RuleContext,
  traceOptions?: RuleTraceOptions,
): Promise<StopEvaluatorResult> {
  return evaluateRulesForStop(rules, context, traceOptions);
}

export function evaluateRuntimeValidateIntent(context: RuleContext): Promise<EvaluatorResult | null> {
  return evaluateRules([validateIntentRule], context, "PreToolUse");
}

export type { EvaluatorResult as RuntimeEvaluatorResult };
