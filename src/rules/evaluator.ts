import type { PreToolRule, RuleContext } from "./types.js";
import { runAgentWithRetryAndTelemetry } from "../utils/agent-runner.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { APPEAL_COUNTS } from "../utils/transcript-presets.js";
import { logFastPathDeny, logFastPathApproval } from "../utils/logger.js";
import { EXECUTION_TYPES } from "../types.js";
import { startsWithAny } from "../utils/retry.js";
import { deactivatePrediction } from "../utils/prediction-cache.js";

export interface EvaluatorResult {
  decision: "allow" | "deny";
  agent: string;
  reason: string;
  gateNote?: string;
  usesLlm: boolean;
}

export async function evaluateRules(
  rules: PreToolRule[],
  ctx: RuleContext,
  hookName: string,
): Promise<EvaluatorResult | null> {
  // Sort rules by priority
  const sorted = [...rules].sort((a, b) => a.priority - b.priority);

  const triggered: { rule: PreToolRule; llmContext: string }[] = [];
  let gateNote: string | undefined;

  for (const rule of sorted) {
    const result = await rule.check(ctx);

    if (result === null) {
      continue;
    }

    if ("fastAllow" in result) {
      logFastPathApproval(rule.name, hookName, ctx.toolName, ctx.projectDir, result.fastAllow);
      return {
        decision: "allow",
        agent: rule.name,
        reason: result.fastAllow,
        gateNote,
        usesLlm: rule.usesLlm,
      };
    }

    if ("fastDeny" in result) {
      logFastPathDeny(rule.name, hookName, ctx.toolName, ctx.projectDir, result.fastDeny);

      if (rule.appealable) {
        const transcriptResult = await readTranscriptExact(ctx.transcriptPath, {
          ...APPEAL_COUNTS,
          includeSlashCommandContext: true,
        });
        const transcript = formatTranscriptResult(transcriptResult);
        const toolDescription = `${ctx.toolName} with ${JSON.stringify(ctx.toolInput).slice(0, 200)}`;

        const appeal = await appealHelper(
          ctx.toolName,
          toolDescription,
          transcript,
          result.fastDeny,
          ctx.projectDir,
          hookName,
          `${rule.name} blocked: ${result.fastDeny}`,
          transcriptResult.slashCommandContext
        );

        if (appeal.overturned) {
          gateNote = appeal.gateNote;
          // For prediction-block, deactivate the matching prediction on overturn
          if (rule.name === "prediction-block") {
            await deactivatePrediction(ctx.sessionDir, ctx.toolName, ctx.toolInput);
          }
          continue;
        }
        gateNote = appeal.gateNote;
      }

      // Denial confirmed -- call onDenialConfirmed if present
      await rule.onDenialConfirmed?.(ctx, result.fastDeny);

      return {
        decision: "deny",
        agent: rule.name,
        reason: result.fastDeny,
        gateNote,
        usesLlm: rule.usesLlm,
      };
    }

    if ("llmContext" in result) {
      triggered.push({ rule, llmContext: result.llmContext });
    }
  }

  // If no triggered rules, all passed
  if (triggered.length === 0) {
    return null;
  }

  // Build combined prompt for ONE haiku LLM call
  const outsideSection = ctx.outsideRootPath
    ? `!!! WARNING: THIS TOOL CALL TARGETS A FILE OUTSIDE THE PROJECT ROOT\n` +
      `  target: ${ctx.outsideRootPath}\n` +
      `Be extra conservative. Prefer DENY unless the user's most recent message ` +
      `explicitly authorized editing this specific path.\n\n`
    : "";
  const promptSections = outsideSection + triggered.map(({ rule, llmContext }) =>
    `=== RULE: ${rule.name} ===\n${rule.promptSection}\n\nCONTEXT:\n${llmContext}`
  ).join("\n\n");

  const toolDescription = `${ctx.toolName} with ${JSON.stringify(ctx.toolInput).slice(0, 200)}`;

  let llmOutput = "APPROVE";
  try {
    const llmResult = await runAgentWithRetryAndTelemetry(
      { ...RULE_GATE_AGENT, workingDir: ctx.projectDir },
      {
        prompt: `Evaluate this tool call: ${toolDescription}`,
        context: promptSections,
      },
      {
        formatValidator: (text: string) => startsWithAny(text, ["APPROVE", "DENY:"]),
        formatReminder: "Reply with EXACTLY: APPROVE or DENY: <reason>",
      },
      {
        agent: "rule-gate",
        hookName,
        toolName: ctx.toolName,
        workingDir: ctx.projectDir,
        executionType: EXECUTION_TYPES.LLM,
      }
    );
    llmOutput = llmResult.output;
  } catch {
    logFastPathApproval("rule-gate", hookName, ctx.toolName, ctx.projectDir, "LLM error - fail open");
  }

  if (llmOutput.startsWith("APPROVE")) {
    return null;
  }

  // LLM denied
  const denyReason = llmOutput.startsWith("DENY:")
    ? llmOutput.slice(5).trim()
    : llmOutput;

  // Check if any triggered rule is appealable
  const hasAppealable = triggered.some(({ rule }) => rule.appealable);
  if (hasAppealable) {
    const transcriptResult = await readTranscriptExact(ctx.transcriptPath, {
      ...APPEAL_COUNTS,
      includeSlashCommandContext: true,
    });
    const transcript = formatTranscriptResult(transcriptResult);

    const appeal = await appealHelper(
      ctx.toolName,
      toolDescription,
      transcript,
      denyReason,
      ctx.projectDir,
      hookName,
      `rule-gate blocked: ${denyReason}`,
      transcriptResult.slashCommandContext
    );

    if (appeal.overturned) {
      gateNote = appeal.gateNote;
      return null;
    }
    gateNote = appeal.gateNote;
  }

  // Find the primary denying agent (first appealable triggered rule, or first triggered)
  const primaryRule = triggered.find(({ rule }) => rule.appealable)?.rule || triggered[0].rule;

  return {
    decision: "deny",
    agent: primaryRule.name,
    reason: denyReason,
    gateNote,
    usesLlm: true,
  };
}
