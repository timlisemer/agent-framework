import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";

export const backgroundAgentBlockRule: PreToolRule = {
  name: "background-agent-block",
  displayName: "Background Agent Block",
  priority: 25,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    if (ctx.toolName !== "Agent") return null;
    const input = ctx.toolInput as { run_in_background?: boolean };
    if (input.run_in_background !== true) return null;
    return {
      fastDeny:
        "Backgrounded subagent spawn denied. Agent tool calls with run_in_background=true keep the active-subagents counter > 0 for the lifetime of the background task, which causes subagent-detector.checkCounterFallback to misclassify subsequent main-session tool calls as subagent calls. Re-issue the Agent call with run_in_background omitted or set to false.",
    };
  },
};
