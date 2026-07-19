import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { FILE_TOOLS, extractFilePaths } from "./utils.js";
import {
  planModeEditBlock,
  planModeBashBlock,
  isEditIntentExemptPath,
} from "../utils/edit-intent.js";
import {
  createPlanfileAuthorization,
  isCreatePlanfileTool,
} from "../utils/create-planfile.js";
import { PLAN_MODE_BLOCK_RULE_POLICY } from "./policies.js";

export const planModeBlockRule: PreToolRule = {
  name: "plan-mode-block",
  displayName: "Plan Mode Block",
  priority: 15,
  appealable: false,
  usesLlm: false,
  version: "1",
  configuration: PLAN_MODE_BLOCK_RULE_POLICY,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (isCreatePlanfileTool(ctx.toolName, ctx.rawToolName)) {
      if (
        !createPlanfileAuthorization({
        toolName: ctx.toolName,
        rawToolName: ctx.rawToolName,
        toolInput: ctx.toolInput,
        planMode: ctx.planMode,
        currentPrediction: ctx.state.currentPrediction,
        })
      ) {
        return {
          fastDeny:
            "create_planfile is only available while plan mode is active or required by the current workflow.",
        };
      }
      return null;
    }

    if (!ctx.planMode) {
      return null;
    }

    if (FILE_TOOLS.includes(ctx.toolName)) {
      const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
      const firstFilePath = filePaths[0] ?? "";
      for (const filePath of filePaths) {
        const editBlock = planModeEditBlock(
          ctx.planMode,
          ctx.toolName,
          filePath,
          ctx.sessionDir,
        );
        if (editBlock) {
          return { fastDeny: editBlock };
        }
      }
      // Authoritative fast-allow: plan-file / CLAUDE.md / memory-file edits
      // are the planner's legitimate write targets in plan mode. Stop here
      // before the rule-gate LLM (gate, priority 70) speculates a denial
      // with hallucinated reasoning about post-validation approval.
      if (
        firstFilePath &&
        filePaths.every((filePath) =>
          isEditIntentExemptPath(filePath, ctx.sessionDir),
        )
      ) {
        return {
          fastAllow:
            "Plan mode allows edits to plan files / host instruction files / memory files (path is exempt).",
        };
      }
    }

    if (ctx.toolName === "Bash") {
      const command = (ctx.toolInput as { command?: string }).command || "";
      const bashBlock = planModeBashBlock(
        ctx.planMode,
        ctx.toolName,
        command,
        ctx.projectDir,
      );
      if (bashBlock) {
        return { fastDeny: bashBlock };
      }
    }

    return null;
  },
};
