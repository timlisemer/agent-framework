import * as fs from "fs";
import * as path from "node:path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { TOOL_APPROVE_PROMPT_SECTION } from "../utils/agent-configs.js";
import { FILE_TOOLS, extractFilePaths, isPlanFile } from "./utils.js";
import { planModeEditBlock, planModeBashBlock } from "../utils/edit-intent.js";
import { RESTRICTED_MCPS } from "../utils/slash-commands.js";
import { activeSpec } from "../adapter/spec.js";
import { classifyBashCommand } from "../utils/command-patterns.js";
import { recordDenial, MAX_SIMILAR_DENIALS } from "../utils/denial-cache.js";
import { resolvePlanPath, readPlanContent } from "../utils/session-utils.js";
import { checkPlanIntent } from "../agents/hooks/plan-validate.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { PLAN_VALIDATE_COUNTS } from "../utils/transcript-presets.js";
import { logFastPathDeny } from "../utils/logger.js";

export const toolApproveRule: PreToolRule = {
  name: "tool-approve",
  displayName: "Tool Approve",
  priority: 100,
  appealable: true,
  usesLlm: true,
  promptSection: TOOL_APPROVE_PROMPT_SECTION,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Plan files are handled by the dedicated plan-validate block in
    // pre-tool-use.ts. Never let the tool-approve LLM speak for them —
    // it has no concept of the plans-dir exception and would sample
    // "DENY outside project" nondeterministically.
    if (FILE_TOOLS.includes(ctx.toolName)) {
      for (const fp of extractFilePaths(ctx.toolName, ctx.toolInput)) {
        const abs = path.isAbsolute(fp) ? fp : path.resolve(ctx.projectDir, fp);
        if (isPlanFile(abs)) return null;
      }
    }

    // ExitPlanMode: block if plan file doesn't exist or is empty
    if (ctx.toolName === "ExitPlanMode") {
      const planPath = await resolvePlanPath(ctx.transcriptPath);
      if (!planPath || !(await fs.promises.stat(planPath)).size) {
        logFastPathDeny("exit-plan-mode", "PreToolUse", ctx.toolName, ctx.projectDir, "Cannot exit plan mode without a plan.");
        return { fastDeny: "Cannot exit plan mode without a plan." };
      }

      // Plan exists and is non-empty -- validate content before allowing exit
      const planContent = await readPlanContent(ctx.transcriptPath);
      const planResult = await readTranscriptExact(ctx.transcriptPath, PLAN_VALIDATE_COUNTS);
      const conversationContext = formatTranscriptResult(planResult);
      const exitValidation = await checkPlanIntent(
        planContent,
        ctx.toolName as "Write" | "Edit",
        ctx.toolInput as { content?: string; old_string?: string; new_string?: string },
        conversationContext,
        ctx.transcriptPath,
        ctx.projectDir,
        "PreToolUse",
        "exit"
      );
      if (!exitValidation.approved) {
        return { fastDeny: `Plan validation failed: ${exitValidation.reason}` };
      }
      // Plan validation passed -- allow without LLM tool-approve check.
      // `return null` is insufficient: it passes to later rules (gate LLM)
      // which incorrectly classify ExitPlanMode as an "implementation action" in plan mode.
      return { fastAllow: "ExitPlanMode approved after plan validation" };
    }

    // Deterministic pre-checks for plan mode blocks
    if (ctx.planModeCtx.contextString) {
      const input = ctx.toolInput as Record<string, unknown>;
      for (const filePath of extractFilePaths(ctx.toolName, ctx.toolInput)) {
        const editBlock = planModeEditBlock(true, ctx.toolName, filePath);
        if (editBlock) return { fastDeny: editBlock };
      }
      const bashBlock = planModeBashBlock(true, ctx.toolName, (input?.command as string) ?? "");
      if (bashBlock) return { fastDeny: bashBlock };
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

    // Contribute aggregator context — host instruction files + tool target.
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

  async onDenialConfirmed(ctx: RuleContext, _reason: string): Promise<void> {
    // Track workaround patterns for escalation. The force-check-required rule
    // (priority 32) consumes state.forceCheckPending to deny all subsequent
    // tools except the agent-framework check MCP / ToolSearch.
    if (ctx.toolName !== "Bash") return;
    const command = (ctx.toolInput as { command?: string }).command ?? "";
    const classification = classifyBashCommand(command, ctx.projectDir);
    if (classification.riskClass === "high-risk-workaround" && classification.workaroundCategory) {
      const count = await recordDenial(classification.workaroundCategory);
      if (count >= MAX_SIMILAR_DENIALS) {
        // Note: reason is modified by the evaluator based on this count
      }

      await ctx.stateManager.update((s) => ({ ...s, forceCheckPending: true }));
    }
  },
};
