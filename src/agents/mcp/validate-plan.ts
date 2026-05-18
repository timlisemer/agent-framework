/**
 * Validate Plan MCP Agent
 *
 * Validates a plan file against the planning contract using
 * deterministic plan checks plus the existing plan-validate LLM.
 *
 * @module validate-plan
 */

import * as fs from "fs";
import * as path from "path";
import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { PLAN_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { startsWithAny } from "../../utils/retry.js";
import { logAgentResult, logAgentStarted } from "../../utils/logger.js";
import { setTranscriptPath } from "../../utils/execution-context.js";
import { type CancellationOptions, throwIfAborted } from "../../utils/cancellation.js";
import { activeSpec, mcpWireNameForText } from "../../adapter/spec.js";
import { collectPlanValidationViolations } from "../hooks/plan-validate.js";
import {
  hashPlanContent,
  recordPlanValidationStatus,
} from "../../utils/plan-validation-status.js";
import { getAgentFrameworkSessionDir } from "../../utils/paths.js";
import { appendPlanfileValidationWorkflow } from "../../utils/planfile.js";

const VALIDATE_PLAN_SYSTEM_PROMPT = `You are a plan validator. Validate the PLAN CONTENT itself.

You are NOT checking whether the plan matches a user's intent. You only check whether the plan is complete, concrete, structurally valid, and ready for implementation.

Honor every [VIOLATION: ...] line in === VIOLATIONS DETECTED === as authoritative remediation input.

Final plans must satisfy the planning contract:
- Use exactly the 14 required ## headings when a final plan is being validated, in this order:
  User Goal, Answered Assumptions, Goal In My Words, Approach, Data Flow, Files To Create, Files To Modify, Implementation Order, Assistant Verification, Manual User Verification, Approaches Decided Against, Possible Future Followups, Relevant Files, Files That Need Changes.
- Begin with \`Plan Name: <lowercase-kebab-name>\`.
- End with \`Planfile Path: <absolute-or-resolved-path>\` followed by \`Plan Name: <same-name>\`.
- Relevant Files and Files That Need Changes are required headings. Do not reject them as extra headings when they appear as level-two headings in the required order.
- Include concrete file paths, symbols, anchors, and implementation details.
- Include enough detail that two independent implementers would make the same edits.
- Include an Assistant Verification section using only the agent-framework check MCP with working_dir.
- Include a Manual User Verification section only for checks the user must perform outside AI-accessible verification, or state that none is required.
- Do not include generic verification headings like ## Verification, ## Testing, or ## Test Plan.
- Do not include schedule buckets, time estimates, live option menus, unresolved assumptions, or vague required section bodies.
- Do not invent behavioral numbers, thresholds, timeouts, or counts.
- Do not include blacklisted commands outside Manual User Verification.

Reply with EXACTLY:
VALID
or
INVALID: <specific heading, line, or rule that failed>

INVALID reasons must be actionable. Name the exact heading, section, line, or contract rule. Do not reply with generic reasons like "the plan does not follow the contract" or "missing required structure".`;

export interface ValidatePlanInput {
  workingDir: string;
  planFile: string;
  transcriptPath?: string;
  sessionDir?: string;
}

export interface PlanValidationRunResult {
  status: "PASS" | "FAIL";
  reasons: string[];
  resolvedPath?: string;
  content?: string;
  contentHash?: string;
}

function getHookName(): string { return activeSpec().mcpWireName("validate_plan"); }

function formatResult(status: "PASS" | "FAIL", reasons: readonly string[]): string {
  const body = reasons.length > 0 ? reasons.join("\n") : "(none)";
  return `## Results
- Status: ${status}

## Reasons
${body}`;
}

function stripViolationPrefix(text: string): string {
  return text.replace(/^\[VIOLATION: ([^\]]+)\]\s*/, "$1: ");
}

function hasSpecificInvalidReason(text: string): boolean {
  const reason = text.replace(/^INVALID:\s*/i, "").trim();
  if (!reason) return false;
  if (/^(the plan|plan)\s+(does not|doesn't|fails to)\s+(follow|satisfy|meet)/i.test(reason)) return false;
  if (/\b(missing|required|extra|duplicate|heading|section|line|rule|contract|verification|specific|vague|unresolved|schedule|option|blacklisted)\b/i.test(reason)) return true;
  return /##\s+\S+|\b(User Goal|Answered Assumptions|Goal In My Words|Approach|Data Flow|Files To Create|Files To Modify|Implementation Order|Assistant Verification|Manual User Verification|Approaches Decided Against|Possible Future Followups|Relevant Files|Files That Need Changes)\b/i.test(reason);
}

function resolvePlanContent(input: ValidatePlanInput): { content?: string; resolvedPath?: string; error?: string } {
  if (typeof input.planFile !== "string" || !input.planFile.trim()) {
    return { error: "plan_file is required." };
  }
  const file = input.planFile;
  const resolved = path.isAbsolute(file) ? file : path.resolve(input.workingDir, file);
  try {
    return { content: fs.readFileSync(resolved, "utf-8"), resolvedPath: resolved };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { error: `Could not read plan_file ${resolved}: ${msg}`, resolvedPath: resolved };
  }
}

export async function runValidatePlanAgent(
  input: ValidatePlanInput,
  options: CancellationOptions = {},
): Promise<string> {
  const result = await validatePlanFileWithContract(input, options);
  return formatResult(result.status, result.reasons);
}

function recordValidationResult(input: ValidatePlanInput, result: PlanValidationRunResult): void {
  if (!result.resolvedPath || result.contentHash === undefined) return;
  const sessionDir = input.sessionDir ??
    (input.transcriptPath ? getAgentFrameworkSessionDir({ transcriptPath: input.transcriptPath }) : undefined);
  if (!sessionDir) return;
  recordPlanValidationStatus({
    sessionDir,
    planPath: result.resolvedPath,
    contentHash: result.contentHash,
    status: result.status === "PASS" ? "pass" : "fail",
    reasons: result.reasons,
  });
}

export async function validatePlanFileWithContract(
  input: ValidatePlanInput,
  options: CancellationOptions = {},
): Promise<PlanValidationRunResult> {
  if (input.transcriptPath) {
    setTranscriptPath(input.transcriptPath);
  }
  const hookName = getHookName();
  logAgentStarted("plan-validate", hookName);

  const source = resolvePlanContent(input);
  if (source.error) {
    const validatePlanWireName = mcpWireNameForText("validate_plan", source.error);
    return {
      status: "FAIL",
      reasons: [appendPlanfileValidationWorkflow(source.error, source.resolvedPath, validatePlanWireName)],
      resolvedPath: source.resolvedPath,
    };
  }

  const plan = source.content ?? "";
  const validatePlanWireName = mcpWireNameForText("validate_plan", plan);
  const baseResult = {
    resolvedPath: source.resolvedPath,
    content: plan,
    contentHash: hashPlanContent(plan),
  };
  if (!plan.trim()) {
    const result: PlanValidationRunResult = {
      ...baseResult,
      status: "FAIL",
      reasons: [appendPlanfileValidationWorkflow("Plan content is empty.", source.resolvedPath, validatePlanWireName)],
    };
    recordValidationResult(input, result);
    return result;
  }

  throwIfAborted(options.signal);
  const findings = collectPlanValidationViolations(plan, input.workingDir, source.resolvedPath);

  if (findings.hardRuleViolations.length > 0) {
    const result: PlanValidationRunResult = {
      ...baseResult,
      status: "FAIL",
      reasons: findings.hardRuleViolations
        .map(stripViolationPrefix)
        .map((reason) => appendPlanfileValidationWorkflow(reason, source.resolvedPath, validatePlanWireName)),
    };
    recordValidationResult(input, result);
    return result;
  }

  if (findings.filteredBlacklistHighlights.length > 0) {
    const result: PlanValidationRunResult = {
      ...baseResult,
      status: "FAIL",
      reasons: findings.blacklistHighlights
        .map(stripViolationPrefix)
        .map((reason) => appendPlanfileValidationWorkflow(reason, source.resolvedPath, validatePlanWireName)),
    };
    recordValidationResult(input, result);
    return result;
  }

  if (findings.allViolations.length > 0) {
    const result: PlanValidationRunResult = {
      ...baseResult,
      status: "FAIL",
      reasons: findings.allViolations
        .map(stripViolationPrefix)
        .map((reason) => appendPlanfileValidationWorkflow(reason, source.resolvedPath, validatePlanWireName)),
    };
    recordValidationResult(input, result);
    return result;
  }

  const result = await runAgentWithRetryAndTelemetry(
    {
      ...PLAN_VALIDATE_AGENT,
      workingDir: input.workingDir,
      systemPrompt: VALIDATE_PLAN_SYSTEM_PROMPT,
    },
    {
      prompt: "Validate whether this plan satisfies the planning contract.",
      context: `PLAN CONTENT:\n${plan}`,
    },
    {
      formatValidator: (text) => text.trim() === "VALID" || startsWithAny(text, ["INVALID:"]),
      formatReminder: "Reply with exactly: VALID or INVALID: <specific heading, line, or rule that failed>",
      maxTokens: 512,
      context: `Validate plan MCP for: ${plan.substring(0, 100)}...`,
    },
    {
      agent: "plan-validate",
      hookName,
      toolName: hookName,
      workingDir: input.workingDir,
      executionType: EXECUTION_TYPES.LLM,
    },
  );

  if (result.output.trim() === "VALID") {
    logAgentResult(result, {
      agent: "plan-validate",
      hookName,
      toolName: hookName,
      workingDir: input.workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "CONFIRM",
      decisionReason: "Plan validation passed",
    });
    const validationResult: PlanValidationRunResult = {
      ...baseResult,
      status: "PASS",
      reasons: [],
    };
    recordValidationResult(input, validationResult);
    return validationResult;
  }

  if (result.output.startsWith("INVALID:")) {
    const reason = result.output.replace("INVALID:", "").trim();
    if (!hasSpecificInvalidReason(result.output)) {
      const validationResult: PlanValidationRunResult = {
        ...baseResult,
        status: "FAIL",
        reasons: [
          appendPlanfileValidationWorkflow(
            "Malformed plan-validate response - retry validation with a specific heading, line, or rule.",
            source.resolvedPath,
            validatePlanWireName,
          ),
        ],
      };
      recordValidationResult(input, validationResult);
      return validationResult;
    }
    logAgentResult(result, {
      agent: "plan-validate",
      hookName,
      toolName: hookName,
      workingDir: input.workingDir,
      executionType: EXECUTION_TYPES.LLM,
      decisionOverride: "DENY",
      decisionReason: reason,
    });
    const validationResult: PlanValidationRunResult = {
      ...baseResult,
      status: "FAIL",
      reasons: [appendPlanfileValidationWorkflow(reason || "Plan validation failed.", source.resolvedPath, validatePlanWireName)],
    };
    recordValidationResult(input, validationResult);
    return validationResult;
  }

  const validationResult: PlanValidationRunResult = {
    ...baseResult,
    status: "FAIL",
    reasons: [appendPlanfileValidationWorkflow("Malformed plan-validate response - retry validation.", source.resolvedPath, validatePlanWireName)],
  };
  recordValidationResult(input, validationResult);
  return validationResult;
}
