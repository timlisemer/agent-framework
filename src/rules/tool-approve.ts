import * as fs from "fs";
import * as path from "node:path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { buildToolApprovePromptSection } from "../utils/agent-configs.js";
import { FILE_TOOLS, extractFilePaths, isPlanFile } from "./utils.js";
import { planModeEditBlock, planModeBashBlock } from "../utils/edit-intent.js";
import { RESTRICTED_MCPS, SLASH_COMMAND_WORKFLOWS } from "../utils/slash-commands.js";
import { activeSpec } from "../adapter/spec.js";
import { classifyBashCommand } from "../utils/command-patterns.js";
import { validateCurrentPlanExit } from "../utils/plan-source.js";
import { logFastPathDeny } from "../utils/logger.js";

export const toolApproveRule: PreToolRule = {
  name: "tool-approve",
  displayName: "Tool Approve",
  priority: 100,
  appealable: true,
  usesLlm: true,
  get promptSection(): string {
    return buildToolApprovePromptSection();
  },

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Plan files are handled by the dedicated plan-validate block in
    // pre-tool-use.ts. Never let the tool-approve LLM speak for them -
    // it has no concept of the plans-dir exception and would sample
    // "DENY outside project" nondeterministically.
    if (FILE_TOOLS.includes(ctx.toolName)) {
      const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
      if (filePaths.length > 0 && filePaths.every((fp) => {
        const abs = path.isAbsolute(fp) ? fp : path.resolve(ctx.projectDir, fp);
        return isPlanFile(abs, ctx.sessionDir);
      })) return null;
    }

    if (activeSpec().isPlanExit({
      event: "PreToolUse",
      canonicalToolName: ctx.toolName,
      rawToolName: ctx.rawToolName,
      toolInput: ctx.toolInput,
    })) {
      const exitValidation = await validateCurrentPlanExit({
        transcriptPath: ctx.transcriptPath,
        sessionDir: ctx.sessionDir,
        projectDir: ctx.projectDir,
        hookName: "PreToolUse",
      });
      if (!exitValidation.approved) {
        if (exitValidation.reason === "Cannot exit plan mode without a plan.") {
          logFastPathDeny("exit-plan-mode", "PreToolUse", ctx.toolName, ctx.projectDir, exitValidation.reason);
          return { fastDeny: exitValidation.reason };
        }
        return { fastDeny: `Plan validation failed: ${exitValidation.reason}` };
      }
      // Plan validation passed -- allow without LLM tool-approve check.
      // `return null` is insufficient: it passes to later rules (gate LLM)
      // which incorrectly classify plan exit as an "implementation action" in plan mode.
      return { fastAllow: "Plan exit approved after plan validation" };
    }

    // Deterministic pre-checks for plan mode blocks
    if (ctx.planModeCtx.contextString) {
      const input = ctx.toolInput as Record<string, unknown>;
      for (const filePath of extractFilePaths(ctx.toolName, ctx.toolInput)) {
        const editBlock = planModeEditBlock(true, ctx.toolName, filePath, ctx.sessionDir);
        if (editBlock) return { fastDeny: editBlock };
      }
      const bashBlock = planModeBashBlock(true, ctx.toolName, (input?.command as string) ?? "");
      if (bashBlock) return { fastDeny: bashBlock };
    }

    {
      const spec = activeSpec();
      const mcp = spec.recognizeMcp(ctx.rawToolName ?? ctx.toolName);
      if (mcp === "check") {
        return { fastAllow: "agent-framework check MCP is always available for verification" };
      }
      if (mcp && RESTRICTED_MCPS.has(mcp) && !ctx.slashCommandAllowedTools?.includes(ctx.toolName)) {
        const hint = spec.renderWorkflowAuthorizationHint(SLASH_COMMAND_WORKFLOWS);
        return {
          fastDeny: `${ctx.rawToolName ?? ctx.toolName} requires explicit workflow authorization (${hint}).`,
        };
      }
    }

    // Contribute aggregator context - host instruction files + tool target.
    const host = ctx.host;
    const instructionFiles = host?.instructionFiles ?? [path.join(ctx.projectDir, "CLAUDE.md")];
    const chunks = await Promise.all(
      instructionFiles.map(async (file) => {
        const content = await fs.promises.readFile(file, "utf-8").catch(() => "");
        return content ? `# ${path.basename(file)}\n${content}` : "";
      })
    );
    const rulesText = chunks.filter(Boolean).join("\n\n");
    if (!rulesText) return null;

    const bashPolicyContext = ctx.toolName === "Bash"
      ? (() => {
        const classification = classifyBashCommand(
          String((ctx.toolInput as { command?: unknown }).command ?? ""),
          ctx.projectDir,
        );
        return `\nBASH POLICY CLASSIFICATION:\nclass: ${classification.riskClass}\nread_only: ${classification.readOnly ? "true" : "false"}\nprediction identities: ${classification.predictionIdentities.join(", ")}\nread-only-heavy evaluation is not build/compile.\n`;
      })()
      : "";

    return {
      llmContext:
        `PROJECT RULES (from ${host?.instructionLabel ?? "CLAUDE.md"}):\n${rulesText}\n\n` +
        `TOOL TO EVALUATE:\nTool: ${ctx.toolName}\nInput: ${JSON.stringify(ctx.toolInput)}${bashPolicyContext}`,
    };
  },

};
