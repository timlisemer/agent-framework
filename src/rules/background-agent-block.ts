import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";

export const backgroundAgentBlockRule: PreToolRule = {
  name: "background-agent-block",
  displayName: "Background Agent Block",
  priority: 25,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.toolName !== "Agent") return null;
    const input = ctx.toolInput as { run_in_background?: boolean };
    if (input.run_in_background !== true) return null;
    return {
      fastDeny:
        "Background Agent launches are not allowed. Re-issue the Agent call with run_in_background omitted or set to false.",
    };
  },
};
