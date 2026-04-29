import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS } from "./utils.js";
import {
  planModeEditBlock,
  planModeBashBlock,
  isEditIntentExemptPath,
} from "../utils/edit-intent.js";

export const planModeBlockRule: PreToolRule = {
  name: "plan-mode-block",
  displayName: "Plan Mode Block",
  priority: 15,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.planMode) {
      return null;
    }

    if (FILE_TOOLS.includes(ctx.toolName)) {
      const filePath =
        (ctx.toolInput as { file_path?: string }).file_path ||
        (ctx.toolInput as { path?: string }).path || "";
      const editBlock = planModeEditBlock(ctx.planMode, ctx.toolName, filePath);
      if (editBlock) {
        return { fastDeny: editBlock };
      }
      // Authoritative fast-allow: plan-file / CLAUDE.md / memory-file edits
      // are the planner's legitimate write targets in plan mode. Stop here
      // before the rule-gate LLM (gate, priority 70) speculates a denial
      // with hallucinated reasoning about post-validation approval.
      if (isEditIntentExemptPath(filePath)) {
        return {
          fastAllow:
            "Plan mode allows edits to plan files / CLAUDE.md / memory files (path is exempt).",
        };
      }
    }

    if (ctx.toolName === "Bash") {
      const command = (ctx.toolInput as { command?: string }).command || "";
      const bashBlock = planModeBashBlock(ctx.planMode, ctx.toolName, command);
      if (bashBlock) {
        return { fastDeny: bashBlock };
      }
    }

    return null;
  },
};
