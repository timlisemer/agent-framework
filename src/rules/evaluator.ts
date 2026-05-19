import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgentWithRetryAndTelemetry } from "../utils/agent-runner.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { extractGateNote } from "../utils/gate-reasoning-cache.js";
import { isFabricatedDenyReason } from "../utils/fabricated-deny-patterns.js";
import { buildAppealUserState } from "../agents/hooks/tool-appeal-user-state.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { APPEAL_COUNTS } from "../utils/transcript-presets.js";
import { logFastPathDeny, logFastPathApproval } from "../utils/logger.js";
import { EXECUTION_TYPES } from "../types.js";
import { startsWithAny } from "../utils/retry.js";
import { summarizeToolInputForLlm } from "../utils/tool-input-summary.js";

export interface EvaluatorResult {
  decision: "allow" | "deny";
  agent: string;
  reason: string;
  gateNote?: string;
  usesLlm: boolean;
}

export interface StopEvaluatorResult {
  decision: "pass" | "block";
  systemMessage?: string;
}

/**
 * Evaluate rules for UserPromptSubmit events.
 * Rules use check() purely for side-effects (e.g., writing state.currentPrediction).
 * All return values are ignored; only side-effects matter.
 */
export async function evaluateRulesForUserPromptSubmit(
  rules: PreToolRule[],
  ctx: RuleContext,
): Promise<void> {
  const eligible = rules
    .filter((r) => (r.events ?? ["PreToolUse"]).includes("UserPromptSubmit"))
    .sort((a, b) => a.priority - b.priority);
  for (const rule of eligible) {
    await rule.check(ctx);
  }
}

/**
 * Evaluate rules for Stop events.
 * Runs eligible rules in priority order. The first stopBlock result wins.
 */
export async function evaluateRulesForStop(
  rules: PreToolRule[],
  ctx: RuleContext,
): Promise<StopEvaluatorResult> {
  const eligible = rules
    .filter((r) => (r.events ?? ["PreToolUse"]).includes("Stop"))
    .sort((a, b) => a.priority - b.priority);
  for (const rule of eligible) {
    const result: RuleCheckResult = await rule.check(ctx);
    if (result && "stopBlock" in result) {
      return { decision: "block", systemMessage: result.stopBlock };
    }
  }
  return { decision: "pass" };
}

export async function evaluateRules(
  rules: PreToolRule[],
  ctx: RuleContext,
  hookName: string,
): Promise<EvaluatorResult | null> {
  // Sort rules by priority, filter to PreToolUse-eligible only
  const sorted = [...rules]
    .filter((r) => (r.events ?? ["PreToolUse"]).includes(ctx.hookEvent ?? "PreToolUse"))
    .sort((a, b) => a.priority - b.priority);

  const triggered: { rule: PreToolRule; llmContext: string }[] = [];
  const deferredDenies: { rule: PreToolRule; fastDeny: string }[] = [];
  let gateNote: string | undefined;

  for (const rule of sorted) {
    const result = await rule.check(ctx);

    if (result === null) {
      continue;
    }

    if ("fastAllow" in result) {
      // If a higher-priority rule has already requested an LLM judgement
      // (llmContext) OR has a deferred fastDeny pending, the rule-gate
      // aggregator is the authoritative arbiter -- a downstream auto-approver
      // MUST NOT bypass it.
      if (triggered.length > 0 || deferredDenies.length > 0) {
        continue;
      }
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

      // Symmetric guard: if a higher-priority rule has requested LLM
      // judgement, defer this fastDeny. Without this, the immediate-deny
      // path below would short-circuit and silently discard the pending
      // llmContext (the same asymmetry that previously masked respond-first's
      // judgement under prediction-block fastDenies). The deferred deny is
      // applied AFTER the LLM aggregator runs: if the LLM denies, that wins
      // and the deferred deny is moot; if the LLM approves, the deferred
      // deny still fires (through the same appeal path as the immediate
      // case).
      if (triggered.length > 0) {
        deferredDenies.push({ rule, fastDeny: result.fastDeny });
        continue;
      }

      if (rule.appealable) {
        const transcriptResult = await readTranscriptExact(ctx.transcriptPath, {
          ...APPEAL_COUNTS,
          includeSlashCommandContext: true,
        });
        const transcript = formatTranscriptResult(transcriptResult);
        const toolDescription = summarizeToolInputForLlm(ctx.toolName, ctx.toolInput);

        // ============================================================================
        // DO NOT BYPASS appealHelper. DO NOT add a "nonAppealable" flag on
        // RuleCheckResult. DO NOT gate appeal behind mood / trust / frustrationStreak.
        // Appeal is the user's override path and removing it is hostile per the user's
        // explicit directive. If a mood-driven fastDeny is being wrongly overturned,
        // fix the agent's prompt and inputs — see the banner atop
        // src/agents/hooks/tool-appeal.ts.
        // ============================================================================
        const appeal = await appealHelper(
          ctx.toolName,
          toolDescription,
          transcript,
          result.fastDeny,
          ctx.projectDir,
          hookName,
          buildAppealUserState(ctx.state),
          `${rule.name} blocked: ${result.fastDeny}`,
          transcriptResult.slashCommandContext
        );

        if (appeal.overturned) {
          gateNote = appeal.gateNote;
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

  // If no triggered rules and no deferred denies, all passed
  if (triggered.length === 0 && deferredDenies.length === 0) {
    return null;
  }

  // Defensive: deferredDenies only populate when triggered.length > 0, so this
  // branch is only reachable if that invariant ever changes. Apply the first
  // (highest-priority) deferred deny via the same appeal path as the immediate
  // case.
  if (triggered.length === 0) {
    return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote);
  }

  // Build combined prompt for ONE haiku LLM call
  const outsideSection = ctx.outsideRootPath
    ? `!!! WARNING: THIS TOOL CALL TARGETS A FILE OUTSIDE THE PROJECT ROOT\n` +
      `  target: ${ctx.outsideRootPath}\n` +
      `Be extra conservative. Prefer DENY unless the user's most recent message ` +
      `explicitly authorized editing this specific path.\n\n`
    : "";
  const latestUserIntent = (ctx.latestUserTurn?.logicText || ctx.latestUserMessage || "").trim();
  const currentUserIntentSection = latestUserIntent
    ? `=== CURRENT USER INTENT PRIORITY ===\n` +
      `The live latest user message is authoritative when it conflicts with older cached or recent-message context:\n` +
      `${latestUserIntent}\n\n`
    : "";
  const promptSections = outsideSection + currentUserIntentSection + triggered.map(({ rule, llmContext }) =>
    `=== RULE: ${rule.name} ===\n${rule.promptSection}\n\nCONTEXT:\n${llmContext}`
  ).join("\n\n");

  const toolDescription = summarizeToolInputForLlm(ctx.toolName, ctx.toolInput);

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
    const llmGateNote = extractGateNote(llmOutput);
    if (llmGateNote) gateNote = llmGateNote;
  } catch {
    logFastPathApproval("rule-gate", hookName, ctx.toolName, ctx.projectDir, "LLM error - fail open");
  }

  if (llmOutput.startsWith("APPROVE")) {
    // LLM approved -- but if any deferred denies are pending, the symmetric
    // fastDeny guard means they still get to fire. Apply the first
    // (highest-priority) one through the same appeal path as the immediate
    // case.
    if (deferredDenies.length > 0) {
      return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote);
    }
    return null;
  }

  // LLM denied
  const denyReason = llmOutput.startsWith("DENY:")
    ? llmOutput.slice(5).trim()
    : llmOutput;

  if (isFabricatedDenyReason(denyReason)) {
    console.error(`[rule-gate] Discarded hallucinated deny reason: ${denyReason.slice(0, 200)}`);
    if (deferredDenies.length > 0) return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote);
    return null;
  }

  // Check if any triggered rule is appealable
  const hasAppealable = triggered.some(({ rule }) => rule.appealable);
  if (hasAppealable) {
    const transcriptResult = await readTranscriptExact(ctx.transcriptPath, {
      ...APPEAL_COUNTS,
      includeSlashCommandContext: true,
    });
    const transcript = formatTranscriptResult(transcriptResult);

    // ============================================================================
    // DO NOT BYPASS appealHelper. DO NOT add a "nonAppealable" flag on
    // RuleCheckResult. DO NOT gate appeal behind mood / trust / frustrationStreak.
    // Appeal is the user's override path and removing it is hostile per the user's
    // explicit directive. If a mood-driven LLM deny is being wrongly overturned,
    // fix the agent's prompt and inputs — see the banner atop
    // src/agents/hooks/tool-appeal.ts.
    // ============================================================================
    const appeal = await appealHelper(
      ctx.toolName,
      toolDescription,
      transcript,
      denyReason,
      ctx.projectDir,
      hookName,
      buildAppealUserState(ctx.state),
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

/**
 * Apply a fastDeny that was deferred past the LLM aggregator due to a
 * higher-priority rule's pending llmContext. Mirrors the immediate-fastDeny
 * appeal path (see the loop body above) -- on overturn, returns null (allow);
 * on uphold or non-appealable, returns the deny.
 */
async function applyDeferredDeny(
  deferred: { rule: PreToolRule; fastDeny: string },
  ctx: RuleContext,
  hookName: string,
  gateNote: string | undefined,
): Promise<EvaluatorResult | null> {
  const { rule, fastDeny } = deferred;

  if (rule.appealable) {
    const transcriptResult = await readTranscriptExact(ctx.transcriptPath, {
      ...APPEAL_COUNTS,
      includeSlashCommandContext: true,
    });
    const transcript = formatTranscriptResult(transcriptResult);
    const toolDescription = summarizeToolInputForLlm(ctx.toolName, ctx.toolInput);

    const appeal = await appealHelper(
      ctx.toolName,
      toolDescription,
      transcript,
      fastDeny,
      ctx.projectDir,
      hookName,
      buildAppealUserState(ctx.state),
      `${rule.name} blocked: ${fastDeny}`,
      transcriptResult.slashCommandContext,
    );

    if (appeal.overturned) {
      return null;
    }
    gateNote = appeal.gateNote;
  }

  await rule.onDenialConfirmed?.(ctx, fastDeny);

  return {
    decision: "deny",
    agent: rule.name,
    reason: fastDeny,
    gateNote,
    usesLlm: rule.usesLlm,
  };
}
