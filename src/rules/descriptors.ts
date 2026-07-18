import { ruleDescriptorSchema, type RuleDescriptor } from "../effects/rule-observability.js";
import type { PreToolRule } from "./types.js";

export function describeRule(rule: PreToolRule): RuleDescriptor {
  return ruleDescriptorSchema.parse({
    ruleId: ruleId(rule),
    name: rule.name,
    displayName: rule.displayName,
    priority: rule.priority,
    supportedHookEvents: rule.events ?? ["PreToolUse"],
    appealable: rule.appealable,
    usesLlm: rule.usesLlm,
    version: rule.version ?? "1",
    configuration: rule.configuration ?? {},
  });
}

export function describeRules(rules: readonly PreToolRule[]): RuleDescriptor[] {
  return [...rules]
    .sort((left, right) => left.priority - right.priority)
    .map(describeRule);
}

export function ruleId(rule: Pick<PreToolRule, "name">): string {
  return `agent-framework.rule.${rule.name}`;
}
