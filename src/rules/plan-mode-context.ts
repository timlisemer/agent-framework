import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";

export const planModeContextRule: PreToolRule = {
  name: "plan-mode-context",
  displayName: "Plan Mode Context",
  priority: 76,
  appealable: false,
  usesLlm: true,
  promptSection: `If "PLAN MODE ACTIVE" appears in context, the user's intent is exploration/planning. Read-only tools should be APPROVED. Edits to plan files (\`~/.claude/plans/*.md\`), \`CLAUDE.md\`, and memory files are also APPROVED — those are the planner's legitimate write targets in plan mode. Do not deny based on "user wants implementation."`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    if (!ctx.planModeCtx.active) return null;
    return { llmContext: ctx.planModeCtx.contextString };
  },
};
