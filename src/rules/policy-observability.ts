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
import { BLACKLIST_PATTERNS } from "../utils/bash-command-policy.js";
import { SENSITIVE_PATH_CLASSIFICATION_POLICY } from "../utils/sensitive-paths.js";
import type { BlacklistPattern } from "../utils/bash-policy/types.js";
import type { PreToolRule } from "./types.js";

export function observableBlacklistPolicyDigest(): string {
  return digestScenarioValue(
    BLACKLIST_PATTERNS.map(observableBlacklistPattern),
  );
}

export function observableBlacklistPattern(
  entry: BlacklistPattern,
): Record<string, JsonValue> {
  return {
    pattern: entry.pattern.source,
    flags: entry.pattern.flags,
    contentPattern: entry.contentPattern?.source ?? null,
    contentFlags: entry.contentPattern?.flags ?? null,
    commandMatcher: observableFunctionIdentity(entry.commandMatcher),
    contentMatcher: observableFunctionIdentity(entry.contentMatcher),
    name: entry.name,
    alternative: typeof entry.alternative === "function"
      ? {
          kind: "dynamic",
          functionName: observableFunctionIdentity(entry.alternative),
        }
      : {
          kind: "literal",
          value: entry.alternative,
        },
    bashOnly: entry.bashOnly ?? false,
    redactPaths: entry.redactPaths ?? false,
    topic: entry.topic ?? null,
  };
}

function observableFunctionIdentity(value: unknown): string | null {
  if (typeof value !== "function") return null;
  return value.name.trim() || "anonymous";
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
  return {
    appealAgent: observableAgentConfiguration(buildToolAppealAgent()),
    appealTranscriptWindow: observableTranscriptWindow(APPEAL_COUNTS),
    appealGuidanceDigest: digestScenarioValue(
      typeof rule.appealGuidance === "string" ? rule.appealGuidance : null,
    ),
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
