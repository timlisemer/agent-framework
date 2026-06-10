import { activeSpec } from "../adapter/spec.js";
import type { AdapterToolCallContext } from "../adapter/types.js";
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

export function summarizeRuleToolCall(ctx: RuleContext): string {
  return activeSpec().summarizeToolCallForLlm(adapterToolCallContextFromRuleContext(ctx));
}

export function appealToolIdentityFromRuleContext(ctx: RuleContext): AppealToolIdentity {
  const spec = activeSpec();
  const toolCall = adapterToolCallContextFromRuleContext(ctx);
  return {
    rawToolName: toolCall.rawToolName,
    canonicalToolName: toolCall.canonicalToolName,
    rawToolNameIsAppealAlias: spec.rawToolNameIsAppealAlias?.(toolCall) === true,
  };
}

export function isFabricatedDenyForRuleTool(reason: string, ctx: RuleContext): boolean {
  const spec = activeSpec();
  const toolCall = adapterToolCallContextFromRuleContext(ctx);
  return (
    spec.isFabricatedDenyReason?.(reason, toolCall) === true ||
    isFabricatedDenyReason(reason)
  );
}
