import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { checkToolApproval } from "../agents/hooks/tool-approve.js";

export const subagentRule: PreToolRule = {
  name: "subagent",
  displayName: "Subagent",
  priority: 20,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.subagent) {
      return null;
    }

    if (ctx.toolName === "Bash") {
      return { fastDeny: "Bash tool is not available in subagents" };
    }

    const decision = await checkToolApproval(
      ctx.toolName,
      ctx.toolInput,
      ctx.projectDir,
      "PreToolUse",
      { lazyMode: true, planModeContext: ctx.planModeCtx.contextString }
    );

    if (!decision.approved) {
      return { fastDeny: decision.reason ?? "Tool denied" };
    }

    return { fastAllow: "Subagent tool approved" };
  },
};
