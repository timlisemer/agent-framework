/**
 * Compatibility facade for Bash command policy, risk classification,
 * blacklist highlights, and workaround detection.
 *
 * Implementation lives in src/utils/bash-policy/.
 */

import { activeSpec } from "../adapter/spec.js";
import { resolveCheckMessage } from "./check-target-context.js";
import { renderCheckMcpAction, renderGitWorkflowAlternative } from "./policy-message-rendering.js";
import {
  BLACKLIST_PATTERNS,
  CHECK_EQUIVALENTS,
  CHECK_ROUTED_COMMAND_POLICIES,
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_GIT_COMMANDS_DESCRIPTION,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  WORKAROUND_PATTERNS,
  checkReadOnlyBashAllowlist,
  classifyBashCommand as classifyBashCommandFromPolicy,
  detectCheckRoutedWorkaroundCommand,
  detectWorkaroundCommand,
  detectWorkaroundPattern,
  evaluateBashPolicy as evaluateBashPolicyFromPolicy,
  getBlacklistDescription as getBlacklistDescriptionFromPolicy,
  getBlacklistHighlights as getBlacklistHighlightsFromPolicy,
  getCheckRoutedCommandHighlights as getCheckRoutedCommandHighlightsFromPolicy,
  getHardBlacklistHighlights as getHardBlacklistHighlightsFromPolicy,
} from "./bash-policy/registry.js";
import {
  getContentBlacklistHighlights as getContentBlacklistHighlightsFromPolicy,
} from "./bash-policy/content.js";
import type {
  BashCommandClassification,
  BashCommandRiskClass,
  BlacklistHighlight,
  BlacklistPattern,
  BashPolicyMessageOptions,
  CheckRoutedCategory,
  CheckRoutedCommandPolicy,
  ContentBlacklistOptions,
} from "./bash-policy/types.js";
import { isReadOnlyRiskClass } from "./bash-policy/helpers.js";
import {
  bashReadCapabilities,
  bashReviewReadCapabilities,
  bashReadFileOperands,
} from "./bash-policy/read-capability.js";

export { commandBare, stripQuotedRegions } from "./shell-command-parser.js";

export {
  BLACKLIST_PATTERNS,
  CHECK_EQUIVALENTS,
  CHECK_ROUTED_COMMAND_POLICIES,
  READ_ONLY_BASH_COMMANDS,
  READ_ONLY_GIT_COMMANDS_DESCRIPTION,
  READ_ONLY_HEAVY_BASH_COMMANDS,
  WORKAROUND_PATTERNS,
  checkReadOnlyBashAllowlist,
  detectCheckRoutedWorkaroundCommand,
  detectWorkaroundCommand,
  detectWorkaroundPattern,
  bashReadCapabilities,
  bashReviewReadCapabilities,
  bashReadFileOperands,
  isReadOnlyRiskClass,
};

export type {
  BashCommandClassification,
  BashCommandRiskClass,
  BlacklistHighlight,
  BlacklistPattern,
  CheckRoutedCategory,
  CheckRoutedCommandPolicy,
  ContentBlacklistOptions,
};

function policyMessages(): BashPolicyMessageOptions {
  const checkMcpAction = renderCheckMcpAction();
  return {
    checkMcpAction,
    gitWorkflowAlternative: renderGitWorkflowAlternative(),
    renderCheckMessage: (policy, workingDir) =>
      workingDir
        ? resolveCheckMessage(policy.name, policy.equivalents, workingDir)
        : checkMcpAction,
  };
}

export function evaluateBashPolicy(command: string, workingDir?: string) {
  return evaluateBashPolicyFromPolicy(command, workingDir, policyMessages());
}

export function classifyBashCommand(command: string, workingDir?: string): BashCommandClassification {
  return classifyBashCommandFromPolicy(command, workingDir, policyMessages());
}

export function getCheckRoutedCommandHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  return getCheckRoutedCommandHighlightsFromPolicy(toolName, toolInput, workingDir, policyMessages());
}

export function getBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  return getBlacklistHighlightsFromPolicy(toolName, toolInput, workingDir, policyMessages());
}

export function getHardBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  return getHardBlacklistHighlightsFromPolicy(toolName, toolInput, workingDir, policyMessages());
}

export function getBlacklistDescription(): string {
  return getBlacklistDescriptionFromPolicy(policyMessages());
}

export function getContentBlacklistHighlights(
  content: string,
  opts: ContentBlacklistOptions = {},
): BlacklistHighlight[] {
  return getContentBlacklistHighlightsFromPolicy(content, BLACKLIST_PATTERNS, {
    checkMcpMessage: `Use ${activeSpec().renderCheckMcpHint()}`,
    gitWorkflowMessage: renderGitWorkflowAlternative(),
    ...opts,
  });
}

export function getPolicyContentBlacklistHighlights(
  content: string,
  opts: ContentBlacklistOptions = {},
): BlacklistHighlight[] {
  return getContentBlacklistHighlights(content, opts);
}
