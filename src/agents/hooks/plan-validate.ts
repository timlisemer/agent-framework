/**
 * Plan Validate Agent - Plan-Intent Alignment Checker
 *
 * This agent detects when an AI's plan has drifted from the user's original
 * request. It catches contradictions, unrelated scope, and over-engineering.
 *
 * ## FLOW
 *
 * 1. Skip if no user messages or empty plan
 * 2. Run unified agent to check alignment
 * 3. Retry if format is invalid
 * 4. Return OK or DRIFT with feedback
 *
 * ## DRIFT DETECTION
 *
 * Detects:
 * - Plan contradicts user instructions
 * - Plan does something fundamentally different
 * - Plan adds major unrelated scope
 * - Plan includes test sections, time estimates, or manual build commands
 *
 * Allows:
 * - Incomplete but on-track plans
 * - Reasonable interpretation of ambiguous requests
 * - Plans mentioning check MCP tool for verification
 *
 * @module plan-validate
 */

import { EXECUTION_TYPES } from "../../types.js";
import { runAgentWithRetryAndTelemetry } from "../../utils/agent-runner.js";
import { PLAN_VALIDATE_AGENT } from "../../utils/agent-configs.js";
import { logFastPathApproval } from "../../utils/logger.js";
import { startsWithAny } from "../../utils/retry.js";
import { getContentBlacklistHighlights } from "../../utils/command-patterns.js";
import {
  excludeMarkdownSectionBodies,
  getPlanClearingHighlights,
  getRuleViolationHighlights,
  getVerificationStructureHighlights,
} from "../../utils/content-patterns.js";
import { validatePlanContract } from "../../utils/plan-contract.js";
import { activeSpec, mcpWireNameForText } from "../../adapter/spec.js";
import { appendPlanfileValidationWorkflow } from "../../utils/planfile.js";

/**
 * Categories from `RULE_VIOLATION_PATTERNS` that ALWAYS hard-deny without
 * waiting for the LLM. Schedule-bucket and solution-branching drift are
 * fully detectable by regex; the LLM cannot add nuance.
 */
const RULE_VIOLATION_CATEGORY_RE =
  /^\[VIOLATION:\s*(timeline marker|solution branching)\]/i;

export interface PlanValidationViolationSummary {
  allViolations: string[];
  hardRuleViolations: string[];
  filteredBlacklistHighlights: ReturnType<typeof getContentBlacklistHighlights>;
  blacklistHighlights: string[];
}

const USER_GOAL_SECTION = "User Goal";
const MANUAL_USER_VERIFICATION_SECTION = /manual\s+(user\s+)?verification/i;

/**
 * Collect deterministic plan-validation findings that are shared by the
 * plan-edit hook and the validate_plan MCP.
 */
export function collectPlanValidationViolations(
  resultingPlan: string,
  workingDir: string,
  planFilePath?: string,
): PlanValidationViolationSummary {
  const planForContentChecks = excludeMarkdownSectionBodies(resultingPlan, [
    USER_GOAL_SECTION,
  ]);
  const planForBlacklistChecks = excludeMarkdownSectionBodies(resultingPlan, [
    USER_GOAL_SECTION,
    MANUAL_USER_VERIFICATION_SECTION,
  ]);
  const planClearingViolations = getPlanClearingHighlights(resultingPlan);
  const filteredBlacklistHighlights = getContentBlacklistHighlights(planForBlacklistChecks);
  const blacklistHighlights = filteredBlacklistHighlights.map((h) => h.rendered);
  const ruleViolations = getRuleViolationHighlights(planForContentChecks);
  const verificationViolations = getVerificationStructureHighlights(planForContentChecks);
  const contractFindings = validatePlanContract(resultingPlan, workingDir, {
    checkMcpWireName: mcpWireNameForText("check", resultingPlan),
    excludedContentSections: [USER_GOAL_SECTION],
    expectedPlanFile: planFilePath,
  });
  const contractViolations = contractFindings.map((finding) =>
    `[VIOLATION: ${finding.kind}] ${finding.message}`,
  );
  const allViolations = [
    ...planClearingViolations,
    ...blacklistHighlights,
    ...ruleViolations,
    ...verificationViolations,
    ...contractViolations,
  ];
  const hardRuleViolations = ruleViolations.filter((v) =>
    RULE_VIOLATION_CATEGORY_RE.test(v),
  );

  return {
    allViolations,
    hardRuleViolations,
    filteredBlacklistHighlights,
    blacklistHighlights,
  };
}

/**
 * Validate that a plan aligns with user intent.
 *
 * @param currentPlan - The full current plan file (null if new file)
 * @param toolName - The tool being used (Write or Edit)
 * @param toolInput - The tool input with content or old_string/new_string
 * @param conversationContext - Formatted conversation context
 * @param workingDir - Working directory for context
 * @param hookName - Hook that triggered this check (for telemetry)
 * @returns Approval result with optional drift feedback
 *
 * @example
 * ```typescript
 * const result = await checkPlanIntent(currentPlan, "Edit", toolInput, context, cwd, "PreToolUse");
 * if (!result.approved) {
 *   console.log('Plan drift:', result.reason);
 * }
 * ```
 */
export async function checkPlanIntent(
  currentPlan: string | null,
  toolName: "Write" | "Edit",
  toolInput: { content?: string; old_string?: string; new_string?: string },
  conversationContext: string,
  workingDir: string,
  hookName: string,
  mode: "edit" | "exit" = "edit",
  planFilePath?: string,
): Promise<{ approved: boolean; reason?: string }> {
  // No conversation yet - nothing to validate against
  if (!conversationContext.trim()) {
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "No conversation context");
    return { approved: true };
  }

  // Format proposed edit based on tool type
  const proposedEdit =
    toolName === "Write"
      ? toolInput.content ?? ""
      : `old_string: ${toolInput.old_string ?? ""}\nnew_string: ${toolInput.new_string ?? ""}`;

  // Empty proposed edit - allow
  if (!proposedEdit.trim()) {
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "Empty proposed edit");
    return { approved: true };
  }

  // Compute the full resulting plan for regex checks (not just the diff)
  const resultingPlan = toolName === "Write"
    ? toolInput.content ?? ""
    : currentPlan
      ? currentPlan.replace(toolInput.old_string ?? "", toolInput.new_string ?? "")
      : toolInput.new_string ?? "";

  try {
    const {
      allViolations,
      hardRuleViolations,
      filteredBlacklistHighlights,
      blacklistHighlights,
    } = collectPlanValidationViolations(
      resultingPlan,
      workingDir,
      planFilePath,
    );

    // Hard-deny for schedule-bucket and solution-branching categories from
    // RULE_VIOLATION_PATTERNS — these are fully captured by regex and need
    // no LLM nuance.
    if (hardRuleViolations.length > 0) {
      const feedback = hardRuleViolations
        .map((v) => v.replace(/^\[VIOLATION: [^\]]+\]\s*/, ""))
        .join(". ");
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(
          feedback,
          planFilePath,
          activeSpec().mcpWireName("validate_plan"),
        ),
      };
    }

    // Deterministic deny: blacklisted commands outside Manual User
    // Verification, in any mode (Edit or Write). LLM cannot improve on this.
    if (filteredBlacklistHighlights.length > 0) {
      const feedback = blacklistHighlights
        .map((v) => v.replace(/^\[VIOLATION: [^\]]+\]\s*/, ""))
        .join(". ");
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(
          feedback,
          planFilePath,
          activeSpec().mcpWireName("validate_plan"),
        ),
      };
    }

    const violationSection = allViolations.length > 0
      ? `=== VIOLATIONS DETECTED ===\n${allViolations.join("\n")}\n=== END VIOLATIONS ===\n\n`
      : "";

    // Edit mode: fast-path approve if no violations in full plan (Edit only).
    // Write replaces the entire file, so structural issues need LLM review even without regex violations.
    if (mode === "edit" && allViolations.length === 0 && toolName === "Edit") {
      logFastPathApproval("plan-validate", hookName, toolName, workingDir, "No violations in full plan");
      return { approved: true };
    }

    // Exit mode: always call LLM. Edit mode with violations: call LLM for context-aware check.
    const result = await runAgentWithRetryAndTelemetry(
      { ...PLAN_VALIDATE_AGENT },
      {
        prompt: "Check if this plan aligns with the user request.",
        context: `${violationSection}CONVERSATION:\n${conversationContext}\n\nVALIDATE PLAN TOOL:\n${activeValidatePlanGuidance(planFilePath)}\n\nCURRENT PLAN:\n${resultingPlan}\n\nPROPOSED ${toolName.toUpperCase()}:\n${proposedEdit}`,
      },
      {
        formatValidator: (text) => startsWithAny(text, ["OK", "DRIFT:"]),
        formatReminder: "Reply with exactly: OK or DRIFT: <feedback>",
        maxTokens: 512,
        context: `Plan validation for: ${proposedEdit.substring(0, 100)}...`,
      },
      { agent: "plan-validate", hookName, toolName, workingDir, executionType: EXECUTION_TYPES.LLM }
    );

    if (result.output.startsWith("OK")) {
      return { approved: true };
    }

    if (result.output.startsWith("DRIFT:")) {
      const feedback = result.output.replace("DRIFT:", "").trim();
      return {
        approved: false,
        reason: appendPlanfileValidationWorkflow(
          feedback,
          planFilePath,
          activeSpec().mcpWireName("validate_plan"),
        ),
      };
    }

    // Fail closed if response is malformed after retries
    return {
      approved: false,
      reason: appendPlanfileValidationWorkflow(
        "Malformed response - retry the edit",
        planFilePath,
        activeSpec().mcpWireName("validate_plan"),
      ),
    };
  } catch {
    // Fail closed on errors
    logFastPathApproval("plan-validate", hookName, toolName, workingDir, "Error path - fail closed");
    return {
      approved: false,
      reason: appendPlanfileValidationWorkflow(
        "Error during validation - retry the edit",
        planFilePath,
        activeSpec().mcpWireName("validate_plan"),
      ),
    };
  }
}

function activeValidatePlanGuidance(planFilePath?: string): string {
  return planFilePath
    ? `Call ${activeSpec().mcpWireName("validate_plan")} with plan_file: ${planFilePath}.`
    : `Call ${activeSpec().mcpWireName("validate_plan")} with plan_file.`;
}
