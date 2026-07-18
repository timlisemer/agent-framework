import fs from "node:fs";
import path from "node:path";
import { runAgent, type AgentExecutionResult } from "../../utils/agent-runner.js";
import { IMPLEMENT_AGENT, IMPLEMENT_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { runCheckAgent } from "./check.js";
import { resolveSessionTranscriptPathForProject } from "../../utils/paths.js";
import { readRecentUserMessagesArray } from "../../utils/transcript.js";
import { EXECUTION_TYPES, parseTierName, MODEL_TIERS, type ModelTier } from "../../types.js";
import { throwIfAborted, type CancellationOptions } from "../../utils/cancellation.js";
import { activeSpec } from "../../adapter/spec.js";
import { logAgentResult } from "../../utils/logger.js";
import { formatImplementationValidatorFailureReport } from "../../utils/implementation-validator-format.js";
import { parseCheckAgentResult } from "../../utils/check-result.js";
import { resolveCanonicalCurrentPlanSource } from "../../utils/plan-source.js";

const IMPLEMENT_VALIDATOR_STATUS_RE = /### Status:\s*(PASS|FAIL)/i;

export type ImplementationWorkflowInput = {
  working_dir?: string;
  planfile?: string;
  model_tier?: "haiku" | "sonnet" | "opus";
  extra_context?: string[];
};

export type ImplementationWorkflowOptions = CancellationOptions & {
  workingDir?: string;
};

export async function runImplementationWorkflow(
  input: ImplementationWorkflowInput,
  options: ImplementationWorkflowOptions = {},
): Promise<string> {
  const prepared = await prepareImplementationWorkflow(input, options, "Implementation Workflow");
  if (!prepared.ok) return prepared.result;

  const implementHookName = getWorkflowHookName("implement");
  const implement = await runAgent(
    {
      ...IMPLEMENT_AGENT,
      tier: prepared.tier,
      workingDir: prepared.workingDir,
    },
    {
      prompt: buildImplementPrompt(prepared.planfile),
      context: prepared.extraContext,
    },
    options,
  );
  logAgentResult(implement, {
    agent: "implement",
    hookName: implementHookName,
    toolName: implementHookName,
    workingDir: prepared.workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: agentRunFailed(implement) ? "DENY" : "CONFIRM",
    decisionReason: agentRunFailed(implement) ? "Implementer failed" : "Implementer completed",
    extraData: {
      planfile: prepared.planfile,
      stage: "implement",
      modelTier: prepared.tier,
    },
  });

  if (agentRunFailed(implement)) {
    return formatImplementationFailure({
      planfile: prepared.planfile,
      implementSummary: implement.output,
      errorCount: implement.errorCount,
    });
  }

  const validation = await runImplementationValidationStage({
    ...prepared,
    implementSummary: implement.output,
    options,
  });

  return formatImplementationResult({
    planfile: prepared.planfile,
    implementSummary: implement.output,
    checkSummary: validation.checkSummary,
    validationSummary: validation.validationSummary,
  });
}

export async function runImplementationValidatorOnly(
  input: ImplementationWorkflowInput,
  options: ImplementationWorkflowOptions = {},
): Promise<string> {
  const prepared = await prepareImplementationWorkflow(input, options, "Implementation Validation");
  if (!prepared.ok) return prepared.result;
  const validation = await runImplementationValidationStage({
    ...prepared,
    options,
  });
  return formatValidationOnlyResult({
    planfile: prepared.planfile,
    checkSummary: validation.checkSummary,
    validationSummary: validation.validationSummary,
  });
}

type PreparedImplementationWorkflow = {
  workingDir: string;
  planfile: string;
  tier: ModelTier;
  extraContext: string;
};

async function prepareImplementationWorkflow(
  input: ImplementationWorkflowInput,
  options: ImplementationWorkflowOptions,
  failureTitle: string,
): Promise<{ ok: true } & PreparedImplementationWorkflow | { ok: false; result: string }> {
  const workingDir = options.workingDir ?? input.working_dir ?? process.cwd();
  throwIfAborted(options.signal);
  const planfile = await resolvePlanfile(input.planfile, workingDir);
  throwIfAborted(options.signal);
  if (!planfile.ok) {
    return {
      ok: false,
      result: formatWorkflowInputFailure(failureTitle, planfile.error),
    };
  }
  throwIfAborted(options.signal);
  const extraContext = await validateQuotedExtraContext(input.extra_context, workingDir);
  throwIfAborted(options.signal);
  if (!extraContext.ok) {
    return {
      ok: false,
      result: formatWorkflowInputFailure(failureTitle, extraContext.error),
    };
  }
  return {
    ok: true,
    workingDir,
    planfile: planfile.path,
    tier: parseWorkflowTier(input.model_tier),
    extraContext: formatExtraContext(input.extra_context),
  };
}

async function runImplementationValidationStage(input: PreparedImplementationWorkflow & {
  implementSummary?: string;
  options: ImplementationWorkflowOptions;
}): Promise<{ checkSummary: string; validationSummary: string }> {
  const checkSummary = await runCheckAgent(input.workingDir, undefined, input.options);
  const validationSummary = await runImplementationValidator({
    planfile: input.planfile,
    workingDir: input.workingDir,
    checkSummary,
    implementSummary: input.implementSummary,
    extraContext: input.extraContext,
    tier: input.tier,
    signal: input.options.signal,
  });
  return { checkSummary, validationSummary };
}

function agentRunFailed(result: AgentExecutionResult): boolean {
  return result.success === false || result.errorCount > 0;
}

export async function runImplementationValidator(input: {
  planfile: string;
  workingDir: string;
  checkSummary: string;
  implementSummary?: string;
  extraContext?: string;
  tier: ModelTier;
  signal?: AbortSignal;
}): Promise<string> {
  const hookName = getWorkflowHookName("validate_implementation");
  const result = await runAgent(
    {
      ...IMPLEMENT_VALIDATE_AGENT,
      tier: input.tier,
      workingDir: input.workingDir,
    },
    {
      prompt: buildValidatorPrompt(input.planfile),
      context: buildValidatorContext(input),
    },
    { signal: input.signal },
  );
  const statusMatch = result.output.match(IMPLEMENT_VALIDATOR_STATUS_RE);
  const status = statusMatch?.[1]?.toUpperCase() ?? "MALFORMED";
  const checkFailed = parseCheckAgentResult(input.checkSummary).failed;
  const failed = checkFailed || agentRunFailed(result) || status !== "PASS";
  logAgentResult(result, {
    agent: "implement-validator",
    hookName,
    toolName: hookName,
    workingDir: input.workingDir,
    executionType: EXECUTION_TYPES.LLM,
    decisionOverride: failed ? "DENY" : "CONFIRM",
    decisionReason: failed ? "Implementation validation failed" : "Implementation validation passed",
    extraData: {
      planfile: input.planfile,
      stage: "validator",
      status,
    },
  });
  if (checkFailed) {
    return formatImplementationValidatorFailureReport({
      checkResults: "FAIL",
      issues: ["Parent-owned check failed; implementation validation cannot pass until checks pass."],
      rawOutput: result.output,
    });
  }
  if (statusMatch && (!agentRunFailed(result) || statusMatch[1]?.toUpperCase() === "FAIL")) {
    return result.output;
  }
  return formatValidatorFailure(result.output, result.errorCount);
}

function getWorkflowHookName(tool: "implement" | "validate_implementation"): string {
  return activeSpec().mcpWireName(tool);
}

export async function resolvePlanfile(
  planfile: string | undefined,
  workingDir: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
  if (planfile) return statPlanfile(path.isAbsolute(planfile) ? planfile : path.resolve(workingDir, planfile));

  const session = resolveSessionTranscriptPathForProject(workingDir);
  if (!session) {
    return { ok: false, error: "No planfile was provided and no active current-plan session could be resolved for working_dir." };
  }

  const current = await resolveCanonicalCurrentPlanSource(session.sessionDir);
  if (!current) {
    return { ok: false, error: "No planfile was provided and the active session has no current planfile." };
  }
  return statPlanfile(current.path);
}

function statPlanfile(planfile: string): { ok: true; path: string } | { ok: false; error: string } {
  try {
    const stat = fs.statSync(planfile);
    if (!stat.isFile()) return { ok: false, error: `planfile is not a file: ${planfile}` };
  } catch {
    return { ok: false, error: `planfile is not a file: ${planfile}` };
  }
  return { ok: true, path: planfile };
}

export async function validateQuotedExtraContext(
  extraContext: string[] | undefined,
  workingDir?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!extraContext || extraContext.length === 0) return { ok: true };
  const userText = await recoverRecentUserText(workingDir);
  if (!userText) {
    return { ok: false, error: "extra_context was provided, but no active transcript user text could be recovered to verify it." };
  }
  const rejected = extraContext.filter((entry) => !entry || !userText.includes(entry));
  if (rejected.length > 0) {
    return { ok: false, error: "extra_context entries must be quoted user text exactly as written in the active transcript." };
  }
  return { ok: true };
}

async function recoverRecentUserText(workingDir?: string): Promise<string> {
  const session = resolveSessionTranscriptPathForProject(workingDir);
  if (!session) return "";
  const userTexts = await readRecentUserMessagesArray(session.transcriptPath, 20, { stripQuoted: false });
  return userTexts.join("\n");
}

function parseWorkflowTier(tier?: string): ModelTier {
  return tier ? parseTierName(tier) : MODEL_TIERS.SONNET;
}

function formatExtraContext(extraContext: string[] | undefined): string {
  return extraContext && extraContext.length > 0
    ? `QUOTED USER EXTRA CONTEXT:
${extraContext.map((entry) => `- ${entry}`).join("\n")}`
    : "";
}

function buildImplementPrompt(planfile: string): string {
  return `Implement the following plan. Read the plan file first, then make all changes exactly as specified.

Plan file: ${planfile}

Implement every change in the plan. Do not skip anything. Do not add anything not in the plan.`;
}

function buildValidatorPrompt(planfile: string): string {
  return `Validate that the following plan was implemented correctly. Read the plan file, then verify every change against the actual codebase.

Plan file: ${planfile}

Check every change in the plan. Report PASS or FAIL for each item. Additional uncommitted code not in the plan is NOT a failure.`;
}

function buildValidatorContext(input: {
  implementSummary?: string;
  extraContext?: string;
  checkSummary: string;
}): string {
  const sections: string[] = [];
  if (input.implementSummary !== undefined) {
    sections.push(`IMPLEMENTER SUMMARY:
${input.implementSummary}`);
  }
  if (input.extraContext) sections.push(input.extraContext);
  sections.push(`PARENT-OWNED CHECK SUMMARY:
${input.checkSummary}`);
  return sections.join("\n\n");
}

function formatImplementationResult(input: {
  planfile: string;
  implementSummary: string;
  checkSummary: string;
  validationSummary: string;
}): string {
  return `## Implementation Workflow
Plan file: ${input.planfile}

## Implementer Result
${input.implementSummary}

## Check Result
${input.checkSummary}

## Validation Result
${input.validationSummary}`;
}

function formatImplementationFailure(input: {
  planfile: string;
  implementSummary: string;
  errorCount: number;
}): string {
  return `## Implementation Workflow
Plan file: ${input.planfile}

ERROR: implementer failed before parent check and validation.
Errors: ${input.errorCount}

## Implementer Result
${input.implementSummary}`;
}

function formatValidationOnlyResult(input: {
  planfile: string;
  checkSummary: string;
  validationSummary: string;
}): string {
  return `## Implementation Validation
Plan file: ${input.planfile}

## Check Result
${input.checkSummary}

## Validation Result
${input.validationSummary}`;
}

function formatValidatorFailure(output: string, errorCount: number): string {
  return formatImplementationValidatorFailureReport({
    issues: ["Validator agent failed or returned malformed output."],
    rawOutput: output,
    errorCount,
  });
}

function formatWorkflowInputFailure(title: string, error: string): string {
  return `## ${title}

ERROR: ${error}`;
}
