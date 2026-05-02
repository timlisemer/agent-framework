import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS, extractFilePaths } from "./utils.js";
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
      const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
      const firstFilePath = filePaths[0] ?? "";
      for (const filePath of filePaths) {
        const editBlock = planModeEditBlock(ctx.planMode, ctx.toolName, filePath);
        if (editBlock) {
          return { fastDeny: editBlock };
        }
      }
      // Authoritative fast-allow: plan-file / CLAUDE.md / memory-file edits
      // are the planner's legitimate write targets in plan mode. Stop here
      // before the rule-gate LLM (gate, priority 70) speculates a denial
      // with hallucinated reasoning about post-validation approval.
      if (firstFilePath && filePaths.every(isEditIntentExemptPath)) {
        return {
          fastAllow:
            "Plan mode allows edits to plan files / host instruction files / memory files (path is exempt).",
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
