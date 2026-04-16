import * as fs from "fs";
import * as path from "node:path";
import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { TOOL_APPROVE_AGENT } from "../utils/agent-configs.js";
import { FILE_TOOLS, extractFilePath, isPlanFile } from "./utils.js";
import { checkToolApproval } from "../agents/hooks/tool-approve.js";
import { detectWorkaroundPattern } from "../utils/command-patterns.js";
import { recordDenial, MAX_SIMILAR_DENIALS } from "../utils/denial-cache.js";
import { savePrediction } from "../utils/prediction-cache.js";
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
  promptSection: TOOL_APPROVE_AGENT.systemPrompt,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    // Plan files are handled by the dedicated plan-validate block in
    // pre-tool-use.ts. Never let the tool-approve LLM speak for them —
    // it has no concept of the plans-dir exception and would sample
    // "DENY outside project" nondeterministically.
    if (FILE_TOOLS.includes(ctx.toolName)) {
      const fp = extractFilePath(ctx.toolName, ctx.toolInput);
      if (fp) {
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

    const decision = await checkToolApproval(
      ctx.toolName,
      ctx.toolInput,
      ctx.projectDir,
      "PreToolUse",
      {
        lazyMode: !ctx.useSyncPipeline && !ctx.outsideRootPath,
        sessionDir: ctx.sessionDir,
        planModeContext: ctx.planModeCtx.contextString,
        outsideRootPath: ctx.outsideRootPath,
      }
    );

    if (!decision.approved) {
      // Blacklist violations are immediate fastDeny (no LLM context needed)
      return { fastDeny: decision.reason ?? "Tool denied" };
    }

    if (!ctx.useSyncPipeline) {
      // Lazy mode with no violations -- pass
      return null;
    }

    // Sync mode -- contribute gate note and context for LLM
    const outsideWarning = ctx.outsideRootPath
      ? `\n\n!!! OUT-OF-TREE TARGET: ${ctx.outsideRootPath} — be extra conservative; prefer DENY unless explicitly authorized.\n`
      : "";
    return {
      llmContext:
        `TOOL APPROVAL CONTEXT:\n${decision.gateNote || "No additional context"}` +
        outsideWarning,
    };
  },

  async onDenialConfirmed(ctx: RuleContext, reason: string): Promise<void> {
    // Track workaround patterns for escalation
    const workaroundCategory = detectWorkaroundPattern(ctx.toolName, ctx.toolInput);
    if (workaroundCategory) {
      const count = await recordDenial(workaroundCategory);
      if (count >= MAX_SIMILAR_DENIALS) {
        // Note: reason is modified by the evaluator based on this count
      }

      // Force check: block all non-low-risk tools until check MCP is called
      await savePrediction(ctx.sessionDir, {
        expectedIntent: "run mcp__agent-framework__check to verify project state",
        blockedIntent: "all non-read tools until check has been run",
        blockedTools: [{
          toolName: ".*",
          reason: `Bash command denied (${workaroundCategory}). You must run mcp__agent-framework__check first.`,
          exceptions: ["mcp__agent-framework__check", "ToolSearch"],
        }],
        source: "gate",
        userMessageSnippet: `denied: ${(reason ?? "").slice(0, 100)}`,
        timestamp: Date.now(),
        active: true,
      });
    }
  },
};
