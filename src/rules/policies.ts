import type { CanonicalMcp } from "../adapter/types.js";
import { MODEL_TIERS } from "../types.js";
import {
  QUESTION_VALIDATE_COUNTS,
  VALIDATE_INTENT_COUNTS,
} from "../utils/transcript-preset-values.js";
import {
  RESTRICTED_MCPS,
  SLASH_COMMAND_WORKFLOWS,
} from "../utils/slash-commands.js";
import {
  observableBlacklistPolicyDigest,
  observableSensitivePathPolicyDigest,
  observableTranscriptWindow,
} from "./policy-observability.js";
import { FILE_TOOLS } from "./utils.js";

const DENIAL_RESOLVING_MCP_NAMES = [
  "check",
  "commit",
  "confirm",
  "fullconfirm",
  "validate_implementation",
] as const satisfies readonly CanonicalMcp[];

export const DENIAL_RESOLVING_MCPS: ReadonlySet<CanonicalMcp> = new Set(
  DENIAL_RESOLVING_MCP_NAMES,
);

export const RESPOND_FIRST_RULE_POLICY = {
      policy: "current-turn-response-required",
      decisionMode: "deterministic",
      transcriptUserMessageCount: 1,
      userMessagePreviewCharacters: 150,
      exemptTools: ["AskUserQuestion", "ExitPlanMode"],
      slashCommandPromptsExcluded: true,
      failurePolicy: "deny-silent-current-turn",
} as const;

export const SENTIMENT_RULE_POLICY = {
      policy: "sentiment-aware-session-state",
      decisionMode: "direct-llm-side-effect",
      timeoutMs: 12_000,
      defaultWindowSize: 2,
      maximumFrustrationStreak: 5,
      moodEscalationStreak: 3,
      lowTrustStreak: 5,
      userMessageSnippetCharacters: 200,
      failurePolicy: "keep-previous-prediction",
} as const;

export const PLAN_MODE_BLOCK_RULE_POLICY = {
      policy: "plan-mode-write-boundary",
      decisionMode: "deterministic",
      fileTools: [...FILE_TOOLS],
      pathClassificationMode: "adapter-plan-instruction-and-memory-exemptions",
      createPlanfilePolicy: "active-plan-mode-or-required-workflow",
      failurePolicy: "deny-disallowed-write",
} as const;

export const BACKGROUND_AGENT_RULE_POLICY = {
      policy: "foreground-agent-only",
      decisionMode: "deterministic",
      toolName: "Agent",
      backgroundField: "run_in_background",
      blockedValue: true,
      appealPolicy: "disabled",
} as const;

export const PREDICTION_QUESTION_RULE_POLICY = {
      policy: "restrictive-mood-question-stalling",
      decisionMode: "direct-llm-side-effect",
      toolName: "AskUserQuestion",
      restrictiveMoods: ["angry", "frustrated"],
      restrictiveTrust: "low",
      defaultWindowSize: 2,
      failurePolicy: "allow",
} as const;

export const QUESTION_VALIDATE_RULE_POLICY = {
      policy: "structured-question-validation",
      decisionMode: "direct-llm-side-effect",
      toolName: "AskUserQuestion",
  transcriptWindow: observableTranscriptWindow(QUESTION_VALIDATE_COUNTS),
      failurePolicy: "allow",
} as const;

export const BLACKLIST_RULE_POLICY = {
      policy: "ordered-hard-command-policy",
      decisionMode: "deterministic",
      workflowRequirementPrecedence: true,
      checkRoutingStateMutation: "required-tool-sequence",
      hardBlacklistPolicyDigest: observableBlacklistPolicyDigest(),
      failurePolicy: "deny-match",
} as const;

export const PREDICTION_BLOCK_RULE_POLICY = {
      policy: "sentiment-prediction-tool-authorization",
      decisionMode: "deterministic",
      appealPolicy: "disabled",
      pathClassificationMode: "edit-intent-exemptions",
      createPlanfileOverride: "unless-explicitly-blocked",
      failurePolicy: "deny-predicted-conflict",
} as const;

export const CREATE_PLANFILE_ALLOW_RULE_POLICY = {
      policy: "canonical-planfile-authorization",
      decisionMode: "deterministic",
      allowModes: ["active-plan-mode", "required-workflow"],
      failurePolicy: "no-op",
} as const;

export const DRIFT_RULE_POLICY = {
      policy: "per-user-turn-edit-drift",
      decisionMode: "deterministic",
      toolHistoryEntries: 50,
      escalationLevels: [0, 1, 2],
      resetBoundary: "user-turn",
      multiRegionPolicy: "explicit-intent-bypass",
      failurePolicy: "deny-detected-drift",
} as const;

export function nextDriftEscalationLevel(
  current: (typeof DRIFT_RULE_POLICY.escalationLevels)[number],
): (typeof DRIFT_RULE_POLICY.escalationLevels)[number] {
  const levels = DRIFT_RULE_POLICY.escalationLevels;
  const currentIndex = levels.indexOf(current);
  return levels[Math.min(Math.max(currentIndex, 0) + 1, levels.length - 1)]!;
}

export const ERROR_ACKNOWLEDGE_RULE_POLICY = {
      policy: "prior-denial-acknowledgement",
      decisionMode: "shared-rule-gate",
      toolHistoryEntries: 5,
      denialResolvingMcps: [...DENIAL_RESOLVING_MCPS],
      transcriptAssistantMessageCount: 1,
      denialKeywordCount: 5,
      assistantPreviewCharacters: 300,
      appealPolicy: "shared-rule-appeal",
} as const;

export const SENSITIVE_PATH_RULE_POLICY = {
      policy: "sensitive-file-path-classification",
      decisionMode: "deterministic",
      fileTools: [...FILE_TOOLS, "Read"],
      pathClassificationMode: "credential-secret-and-key-material",
      classificationPolicyDigest: observableSensitivePathPolicyDigest(),
      failurePolicy: "deny-sensitive-match",
} as const;

export const EDIT_INTENT_RULE_POLICY = {
      policy: "explicit-edit-intent",
      decisionMode: "shared-rule-gate",
      pathClassificationMode: "edit-intent-exemptions",
      appealOverturnThreshold: 2,
      appealPolicy: "shared-rule-appeal",
      missingTargetPolicy: "deny",
} as const;

export const INTENT_FULFILLMENT_CONTEXT_RULE_POLICY = {
      policy: "recent-intent-fulfillment-context",
      decisionMode: "shared-rule-gate-context",
      historySource: "canonical-tool-history",
      failurePolicy: "no-context",
} as const;

export const PREDICTION_CONTEXT_RULE_POLICY = {
      policy: "live-intent-over-cached-prediction",
      decisionMode: "shared-rule-gate-context",
      conflictPrecedence: "live-latest-user-message",
      failurePolicy: "no-context",
} as const;

export const RECENT_MESSAGES_RULE_POLICY = {
      policy: "nested-user-turn-context",
      decisionMode: "shared-rule-gate-context",
      transcriptUserMessageCount: 3,
      minimumMessages: 2,
      order: "oldest-first",
      failurePolicy: "no-context",
} as const;

export const REASONING_HISTORY_RULE_POLICY = {
      policy: "canonical-gate-reasoning-context",
      decisionMode: "shared-rule-gate-context",
      historySource: "gate-reasoning-state-slice",
      failurePolicy: "no-context",
} as const;

export const EDIT_INTENT_CONTEXT_RULE_POLICY = {
      policy: "read-only-intent-context",
      decisionMode: "shared-rule-gate-context",
      activeValue: false,
      failurePolicy: "no-context",
} as const;

export const PLAN_MODE_CONTEXT_RULE_POLICY = {
      policy: "plan-mode-context",
      decisionMode: "shared-rule-gate-context",
      contextSource: "canonical-plan-mode-state",
      failurePolicy: "no-context",
} as const;

export const PLAN_MODE_STEP_CONTEXT_RULE_POLICY = {
      policy: "plan-mode-step-awareness",
      decisionMode: "shared-rule-gate-context",
      fulfillmentSource: "canonical-tool-history",
      terminalTool: "ExitPlanMode",
      failurePolicy: "no-context",
} as const;

export const TOOL_APPROVE_RULE_POLICY = {
      policy: "final-tool-approval",
      decisionMode: "shared-rule-gate",
      fileTools: [...FILE_TOOLS],
      restrictedMcps: [...RESTRICTED_MCPS].sort(),
      slashCommandWorkflows: [...SLASH_COMMAND_WORKFLOWS],
      instructionSource: "adapter-host-context",
      planExitPolicy: "validate-before-allow",
      checkMcpPolicy: "always-available",
      appealPolicy: "shared-rule-appeal",
} as const;

export const VALIDATE_INTENT_RULE_POLICY = {
      policy: "uncommitted-change-intent-validation",
      decisionMode: "direct-llm-side-effect",
  transcriptWindow: observableTranscriptWindow(VALIDATE_INTENT_COUNTS),
      changeSource: "git-status-and-diff",
      planSource: "canonical-plan-current",
      failurePolicy: "surface-validator-result",
} as const;

export const RESPONSE_ALIGN_STOP_RULE_POLICY = {
      policy: "stop-response-alignment",
      decisionMode: "direct-llm-side-effect",
      classifierModelTier: MODEL_TIERS.HAIKU,
      classifierMaximumTokens: 50,
      questionVerifierMaximumTokens: 20,
      shortResponseCharacters: 30,
      answerEvidenceCharacters: 50,
      failurePolicy: "allow",
} as const;
