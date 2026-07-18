import { activeSpec, adapterSpecByName } from "../adapter/spec.js";
import type { AdapterSpec, AdapterToolCallContext } from "../adapter/types.js";
import type { AppealToolIdentity } from "../agents/hooks/tool-appeal.js";
import { isFabricatedDenyReason } from "../utils/fabricated-deny-patterns.js";
import type { RuleContext } from "./types.js";

export function adapterToolCallContextFromRuleContext(ctx: RuleContext): AdapterToolCallContext {
  return {
    rawToolName: ctx.rawToolName ?? ctx.toolName,
    rawToolInput: ctx.rawToolInput ?? ctx.toolInput,
    canonicalToolName: ctx.toolName,
    canonicalToolInput: ctx.toolInput,
  };
}

/** Resolve adapter behavior from the canonical run before falling back to a native hook process. */
export function adapterSpecFromRuleContext(ctx: RuleContext): AdapterSpec {
  return ctx.adapter === undefined ? activeSpec() : adapterSpecByName(ctx.adapter);
}

export function summarizeRuleToolCall(ctx: RuleContext): string {
  return adapterSpecFromRuleContext(ctx).summarizeToolCallForLlm(
    adapterToolCallContextFromRuleContext(ctx),
  );
}

export function appealToolIdentityFromRuleContext(ctx: RuleContext): AppealToolIdentity {
  const spec = adapterSpecFromRuleContext(ctx);
  const toolCall = adapterToolCallContextFromRuleContext(ctx);
  return {
    rawToolName: toolCall.rawToolName,
    canonicalToolName: toolCall.canonicalToolName,
    rawToolNameIsAppealAlias: spec.rawToolNameIsAppealAlias?.(toolCall) === true,
  };
}

export function isFabricatedDenyForRuleTool(reason: string, ctx: RuleContext): boolean {
  const spec = adapterSpecFromRuleContext(ctx);
  const toolCall = adapterToolCallContextFromRuleContext(ctx);
  return (
    spec.isFabricatedDenyReason?.(reason, toolCall) === true ||
    isFabricatedDenyReason(reason)
  );
}
