import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { planModeEditBlock, planModeBashBlock } from "../utils/edit-intent.js";
import {
  classifyBashCommand,
  getBlacklistHighlights,
} from "../utils/command-patterns.js";
import { RESTRICTED_MCPS } from "../utils/slash-commands.js";
import { activeSpec } from "../adapter/spec.js";
import { logFastPathApproval } from "../utils/logger.js";

export const subagentRule: PreToolRule = {
  name: "subagent",
  displayName: "Subagent",
  priority: 20,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.subagent) {
      return null;
    }

    if (ctx.toolName === "Bash") {
      const command = (ctx.toolInput as { command?: string }).command ?? "";
      const classification = classifyBashCommand(command, ctx.projectDir);
      if (!classification.readOnly) {
        return { fastDeny: `Subagent Bash restricted to read-only commands. ${classification.reason ?? "command is not read-only"}` };
      }
      return { fastAllow: `Subagent ${classification.riskClass} Bash approved` };
    }

    // Mirror the four deterministic checks from the old checkToolApproval
    // skipLlmOnClean path. Skipping any of these would allow subagent calls
    // to Edit-in-plan-mode or to restricted MCP tools like the
    // agent-framework commit MCP to slip through silently.
    if (ctx.planModeCtx.contextString) {
      const input = ctx.toolInput as Record<string, unknown>;
      const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
      const editBlock = planModeEditBlock(true, ctx.toolName, filePath);
      if (editBlock) return { fastDeny: editBlock };
      const bashBlock = planModeBashBlock(true, ctx.toolName, (input?.command as string) ?? "");
      if (bashBlock) return { fastDeny: bashBlock };
    }

    const highlights = getBlacklistHighlights(ctx.toolName, ctx.toolInput, ctx.projectDir);
    if (highlights.length > 0) {
      const reason = highlights.map(h => h.replace(/^\[BLACKLIST: [^\]]+\]\s*/, "")).join(". ");
      return { fastDeny: reason };
    }

    {
      const spec = activeSpec();
      const mcp = spec.recognizeMcp(ctx.rawToolName ?? ctx.toolName);
      if (mcp && RESTRICTED_MCPS.has(mcp) && !ctx.slashCommandAllowedTools?.includes(ctx.toolName)) {
        const hint = spec.renderWorkflowAuthorizationHint(["commit", "push", "confirm", "quickpush"]);
        return {
          fastDeny: `${ctx.rawToolName ?? ctx.toolName} requires explicit workflow authorization (${hint}).`,
        };
      }
    }

    logFastPathApproval("subagent", "PreToolUse", ctx.toolName, ctx.projectDir, "Subagent tool approved");
    return { fastAllow: "Subagent tool approved" };
  },
};
