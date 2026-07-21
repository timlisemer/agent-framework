import { buildToolAppealAgent } from "../utils/agent-configs.js";
import type { AgentConfig } from "../utils/agent-runner.js";
import {
  toJsonObject,
  toJsonValue,
  type JsonValue,
} from "../scenario/protocol/common.js";
import { digestScenarioValue } from "../scenario/protocol/digest.js";
import { APPEAL_COUNTS } from "../utils/transcript-preset-values.js";
import type { TranscriptReadOptions } from "../utils/transcript.js";
import {
  BLACKLIST_PATTERNS,
  type BlacklistPattern,
} from "../utils/bash-command-policy.js";
import { SENSITIVE_PATH_CLASSIFICATION_POLICY } from "../utils/sensitive-paths.js";
import type { PreToolRule } from "./types.js";

export function observableBlacklistPolicyDigest(
  patterns: readonly BlacklistPattern[] = BLACKLIST_PATTERNS,
): string {
  return digestScenarioValue({
    identityVersion: 1,
    patterns: patterns.map((entry) => ({
      pattern: entry.pattern.source,
      flags: entry.pattern.flags,
      contentPattern: entry.contentPattern?.source ?? null,
      contentFlags: entry.contentPattern?.flags ?? null,
      commandMatcher: observableFunctionIdentity(
        entry.commandMatcher,
        `${entry.name} command matcher`,
      ),
      contentMatcher: observableFunctionIdentity(
        entry.contentMatcher,
        `${entry.name} content matcher`,
      ),
      name: entry.name,
      alternative:
        typeof entry.alternative === "string"
          ? entry.alternative
          : observableFunctionIdentity(
              entry.alternative,
              `${entry.name} alternative`,
            ),
      bashOnly: entry.bashOnly ?? false,
      redactPaths: entry.redactPaths ?? false,
      topic: entry.topic ?? null,
    })),
  });
}

function observableFunctionIdentity(
  value: { readonly name: string } | undefined,
  fallbackIdentity: string,
): JsonValue {
  if (!value) return null;
  return {
    kind: "namedFunction",
    name: value.name.trim() || fallbackIdentity,
  };
}

export function observableSensitivePathPolicyDigest(): string {
  return digestScenarioValue(toJsonValue(SENSITIVE_PATH_CLASSIFICATION_POLICY));
}

export function observableTranscriptWindow(
  options: TranscriptReadOptions,
): Record<string, JsonValue> {
  return transcriptPolicyValue(options) as Record<string, JsonValue>;
}

function transcriptPolicyValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "all";
  if (Array.isArray(value)) return value.map(transcriptPolicyValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .map(([key, child]) => [key, transcriptPolicyValue(child)]),
    );
  }
  throw new Error(`Unsupported transcript policy value: ${typeof value}`);
}

export function observableRulePolicy(rule: PreToolRule): {
  version: string;
  configuration: Record<string, JsonValue>;
} {
  const configuration: Record<string, JsonValue> = {
    ...toJsonObject(rule.configuration ?? {}),
    ...(rule.usesLlm ? observableLlmPolicy(rule) : {}),
    ...(rule.appealable ? observableAppealPolicy(rule) : {}),
  };
  return {
    version: rule.version ?? "1",
    configuration,
  };
}

function observableLlmPolicy(rule: PreToolRule): Record<string, JsonValue> {
  const hasExplicitEvaluationAgents = Object.hasOwn(
    rule.configuration ?? {},
    "evaluationAgents",
  );
  const agent = rule.evaluationAgent ?? null;
  if (!agent && !hasExplicitEvaluationAgents) {
    throw new Error(
      `LLM rule ${rule.name} does not declare its execution agent`,
    );
  }
  return {
    ...(agent ? { evaluationAgent: observableAgentConfiguration(agent) } : {}),
    rulePromptDigest: digestScenarioValue(rule.promptSection),
  };
}

function observableAppealPolicy(rule: PreToolRule): Record<string, JsonValue> {
  const guidance = rule.appealGuidance;
  const appealGuidanceMode =
    typeof guidance === "function"
      ? "dynamic"
      : typeof guidance === "string"
        ? "static"
        : "default";
  return {
    appealAgent: observableAgentConfiguration(buildToolAppealAgent()),
    appealTranscriptWindow: observableTranscriptWindow(APPEAL_COUNTS),
    appealGuidanceMode,
    appealGuidanceDigest:
      typeof guidance === "string" ? digestScenarioValue(guidance) : null,
  };
}

export function observableAgentConfiguration(
  config: Omit<AgentConfig, "workingDir">,
): JsonValue {
  const outputFormat: Record<string, JsonValue> = config.formatValidation
    ? {
        policy: "validated",
        validator: config.formatValidation.validator.source,
        flags: config.formatValidation.validator.flags,
      }
    : { policy: "freeform" };
  return {
    name: config.name,
    modelTier: config.tier,
    mode: config.mode,
    maximumTokens: config.maxTokens ?? null,
    maximumTurns: config.maxTurns ?? null,
    outputFormat,
    policyDigest: digestScenarioValue({
      name: config.name,
      tier: config.tier,
      mode: config.mode,
      maxTokens: config.maxTokens ?? null,
      maxTurns: config.maxTurns ?? null,
      systemPrompt: config.systemPrompt,
      outputFormat,
    }),
  };
}
