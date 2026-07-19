import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { runAgentWithRetryAndTelemetry } from "../utils/agent-runner.js";
import { extractGateNote } from "./gate-note.js";
import { logFastPathDeny, logFastPathApproval } from "../utils/logger.js";
import { EXECUTION_TYPES } from "../types.js";
import { startsWithAny } from "../utils/retry.js";
import {
  isFabricatedDenyForRuleTool,
  summarizeRuleToolCall,
} from "./tool-call-context.js";
import type {
  RuleEvaluation,
  RuleEvaluationStage,
} from "../effects/rule-observability.js";
import type { JsonValue } from "../scenario/protocol/common.js";
import { ruleId } from "./descriptors.js";
import { isCancellationError, throwIfAborted } from "../utils/cancellation.js";
import { runAppealWithTrace } from "./appeal.js";

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

export interface RuleTraceOptions {
  commandId: string;
  idFactory?: () => string;
  clock?: () => number;
  onTrace(evaluation: RuleEvaluation): void | Promise<void>;
  onStage?(stage: {
    eventType: RuleEvaluationStage["eventType"];
    ruleId: string | null;
    payload: Record<string, JsonValue>;
  }): void;
}

/**
 * Evaluate rules for UserPromptSubmit events.
 * Rules use check() purely for side-effects (e.g., writing state.currentPrediction).
 * All return values are ignored; only side-effects matter.
 */
export async function evaluateRulesForUserPromptSubmit(
  rules: PreToolRule[],
  ctx: RuleContext,
  traceOptions?: RuleTraceOptions,
): Promise<void> {
  const traced = traceRuleChecks(rules, "UserPromptSubmit", traceOptions);
  const eligible = traced.rules
    .filter((r) => (r.events ?? ["PreToolUse"]).includes("UserPromptSubmit"))
    .sort((a, b) => a.priority - b.priority);
  try {
    for (const rule of eligible) {
      throwIfAborted(ctx.signal);
      await rule.check(ctx);
      throwIfAborted(ctx.signal);
    }
  } finally {
    await traced.finish();
  }
}

/**
 * Evaluate rules for Stop events.
 * Runs eligible rules in priority order. The first stopBlock result wins.
 */
export async function evaluateRulesForStop(
  rules: PreToolRule[],
  ctx: RuleContext,
  traceOptions?: RuleTraceOptions,
): Promise<StopEvaluatorResult> {
  const traced = traceRuleChecks(rules, "Stop", traceOptions);
  const eligible = traced.rules
    .filter((r) => (r.events ?? ["PreToolUse"]).includes("Stop"))
    .sort((a, b) => a.priority - b.priority);
  try {
    for (const rule of eligible) {
      throwIfAborted(ctx.signal);
      const result: RuleCheckResult = await rule.check(ctx);
      throwIfAborted(ctx.signal);
      if (result && "stopBlock" in result) {
        return { decision: "block", systemMessage: result.stopBlock };
      }
    }
    return { decision: "pass" };
  } finally {
    await traced.finish();
  }
}

export async function evaluateRules(
  rules: PreToolRule[],
  ctx: RuleContext,
  hookName: string,
  traceOptions?: RuleTraceOptions,
): Promise<EvaluatorResult | null> {
  const traced = traceRuleChecks(rules, ctx.hookEvent ?? "PreToolUse", traceOptions);
  try {
    return await evaluateRulesCore(traced.rules, ctx, hookName, traceOptions);
  } finally {
    await traced.finish();
  }
}

async function evaluateRulesCore(
  rules: PreToolRule[],
  ctx: RuleContext,
  hookName: string,
  traceOptions?: RuleTraceOptions,
): Promise<EvaluatorResult | null> {
  // Sort rules by priority, filter to PreToolUse-eligible only
  const sorted = [...rules]
    .filter((r) => (r.events ?? ["PreToolUse"]).includes(ctx.hookEvent ?? "PreToolUse"))
    .sort((a, b) => a.priority - b.priority);

  const triggered: { rule: PreToolRule; llmContext: string }[] = [];
  const deferredDenies: { rule: PreToolRule; fastDeny: string }[] = [];
  let gateNote: string | undefined;

  const summarizeCurrentTool = () => summarizeRuleToolCall(ctx);

  for (const rule of sorted) {
    throwIfAborted(ctx.signal);
    const result = await rule.check(ctx);
    throwIfAborted(ctx.signal);

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
        const appeal = await runRuleAppeal(
          rule,
          ctx,
          hookName,
          result.fastDeny,
          rule.name,
          traceOptions?.onStage,
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
    return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote, traceOptions);
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

  const toolDescription = summarizeCurrentTool();
  const evaluationAgent = triggered[0]?.rule.evaluationAgent;
  if (!evaluationAgent) {
    throw new Error(`Triggered LLM rule ${triggered[0]?.rule.name ?? "unknown"} does not declare its execution agent`);
  }
  const inconsistentAgent = triggered.find(({ rule }) => rule.evaluationAgent !== evaluationAgent);
  if (inconsistentAgent) {
    throw new Error(
      `Triggered LLM rule ${inconsistentAgent.rule.name} does not share the canonical evaluation agent`,
    );
  }

  let llmOutput = "APPROVE";
  traceOptions?.onStage?.({
    eventType: "rule.gate.requested",
    ruleId: null,
    payload: {
      ruleIds: triggered.map(({ rule }) => ruleId(rule)),
      tool: toolDescription,
    },
  });
  try {
    const llmResult = await runAgentWithRetryAndTelemetry(
      { ...evaluationAgent, workingDir: ctx.projectDir },
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
      },
      { signal: ctx.signal },
    );
    llmOutput = llmResult.output;
    traceOptions?.onStage?.({
      eventType: "rule.gate.completed",
      ruleId: null,
      payload: { result: llmOutput.startsWith("APPROVE") ? "allow" : "deny", output: llmOutput },
    });
    const llmGateNote = extractGateNote(llmOutput);
    if (llmGateNote) gateNote = llmGateNote;
  } catch (error) {
    if (isCancellationError(error)) throw error;
    traceOptions?.onStage?.({
      eventType: "rule.gate.completed",
      ruleId: null,
      payload: {
        result: "failedOpen",
        error: error instanceof Error ? error.message : String(error),
      },
    });
    logFastPathApproval("rule-gate", hookName, ctx.toolName, ctx.projectDir, "LLM error - fail open");
  }

  if (llmOutput.startsWith("APPROVE")) {
    // LLM approved -- but if any deferred denies are pending, the symmetric
    // fastDeny guard means they still get to fire. Apply the first
    // (highest-priority) one through the same appeal path as the immediate
    // case.
    if (deferredDenies.length > 0) {
      return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote, traceOptions);
    }
    return null;
  }

  // LLM denied
  const denyReason = llmOutput.startsWith("DENY:")
    ? llmOutput.slice(5).trim()
    : llmOutput;

  if (isFabricatedDenyForRuleTool(denyReason, ctx)) {
    console.error(`[rule-gate] Discarded hallucinated deny reason: ${denyReason.slice(0, 200)}`);
    if (deferredDenies.length > 0) return applyDeferredDeny(deferredDenies[0], ctx, hookName, gateNote, traceOptions);
    return null;
  }

  // Check if any triggered rule is appealable
  const hasAppealable = triggered.some(({ rule }) => rule.appealable);
  if (hasAppealable) {
    const appealRule = triggered.find(({ rule }) => rule.appealable)?.rule ?? triggered[0].rule;
    const appeal = await runRuleAppeal(
      appealRule,
      ctx,
      hookName,
      denyReason,
      "rule-gate",
      traceOptions?.onStage,
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

function traceRuleChecks(
  rules: readonly PreToolRule[],
  hookEvent: "PreToolUse" | "UserPromptSubmit" | "Stop",
  options: RuleTraceOptions | undefined,
): { rules: PreToolRule[]; finish(): Promise<void> } {
  if (!options) return { rules: [...rules], async finish() {} };
  const now = options.clock ?? Date.now;
  const states = rules.map((rule, index) => ({
    rule,
    eligible: (rule.events ?? ["PreToolUse"]).includes(hookEvent),
    evaluationId: options.idFactory?.() ?? `${options.commandId}:${rule.name}:${index}`,
    terminal: false,
  }));
  let finished = false;
  const tracedRules = states.map((state) => ({
    ...state.rule,
    async check(ruleContext: RuleContext): Promise<RuleCheckResult> {
      const startedAt = now();
      await options.onTrace({
        evaluationId: state.evaluationId,
        ruleId: ruleId(state.rule),
        commandId: options.commandId,
        status: "started",
        result: null,
        reason: null,
        context: null,
        elapsedMs: null,
        error: null,
      });
      try {
        throwIfAborted(ruleContext.signal);
        const result = await state.rule.check(ruleContext);
        throwIfAborted(ruleContext.signal);
        state.terminal = true;
        await options.onTrace({
          evaluationId: state.evaluationId,
          ruleId: ruleId(state.rule),
          commandId: options.commandId,
          status: "completed",
          result: resultKind(result),
          reason: resultReason(result),
          context: result && "llmContext" in result ? result.llmContext : null,
          elapsedMs: Math.max(0, now() - startedAt),
          error: null,
        });
        return result;
      } catch (error) {
        state.terminal = true;
        await options.onTrace({
          evaluationId: state.evaluationId,
          ruleId: ruleId(state.rule),
          commandId: options.commandId,
          status: "failed",
          result: null,
          reason: null,
          context: null,
          elapsedMs: Math.max(0, now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  }));
  return {
    rules: tracedRules,
    async finish() {
      if (finished) return;
      finished = true;
      for (const state of states) {
        if (state.terminal) continue;
        await options.onTrace({
          evaluationId: state.evaluationId,
          ruleId: ruleId(state.rule),
          commandId: options.commandId,
          status: "skipped",
          result: null,
          reason: state.eligible ? "shortCircuited" : "unsupportedHookEvent",
          context: null,
          elapsedMs: null,
          error: null,
        });
      }
    },
  };
}

function resultKind(result: RuleCheckResult): string {
  if (result === null) return "noMatch";
  if ("fastAllow" in result) return "fastAllow";
  if ("fastDeny" in result) return "fastDeny";
  if ("llmContext" in result) return "llmContext";
  return "stopBlock";
}

function resultReason(result: RuleCheckResult): string | null {
  if (result === null) return null;
  if ("fastAllow" in result) return result.fastAllow;
  if ("fastDeny" in result) return result.fastDeny;
  if ("stopBlock" in result) return result.stopBlock;
  return null;
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
  traceOptions?: RuleTraceOptions,
): Promise<EvaluatorResult | null> {
  const { rule, fastDeny } = deferred;

  if (rule.appealable) {
    const appeal = await runRuleAppeal(
      rule,
      ctx,
      hookName,
      fastDeny,
      rule.name,
      traceOptions?.onStage,
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

function runRuleAppeal(
  rule: PreToolRule,
  ctx: RuleContext,
  hookName: string,
  reason: string,
  blockedBy: string,
  onStage: RuleTraceOptions["onStage"],
) {
  const additionalContext = typeof rule.appealGuidance === "function"
    ? rule.appealGuidance(ctx, reason)
    : rule.appealGuidance;
  return runAppealWithTrace({
    context: ctx,
    hookName,
    ruleId: ruleId(rule),
    reason,
    blockedBy,
    additionalContext,
    onOverturned: rule.onAppealOverturned === undefined
      ? undefined
      : () => rule.onAppealOverturned!(ctx, reason),
    onStage,
  });
}
