import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { BACKGROUND_AGENT_RULE_POLICY } from "./policies.js";

export const backgroundAgentBlockRule: PreToolRule = {
  name: "background-agent-block",
  displayName: "Background Agent Block",
  priority: 25,
  appealable: false,
  usesLlm: false,
  version: "1",
  configuration: BACKGROUND_AGENT_RULE_POLICY,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== BACKGROUND_AGENT_RULE_POLICY.toolName) return null;
    const input = ctx.toolInput as Record<string, unknown>;
    if (
      input[BACKGROUND_AGENT_RULE_POLICY.backgroundField] !==
      BACKGROUND_AGENT_RULE_POLICY.blockedValue
    )
      return null;
    return {
      fastDeny:
        "Background Agent launches are not allowed. Re-issue the Agent call with run_in_background omitted or set to false.",
    };
  },
};
