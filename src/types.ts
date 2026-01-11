// Branded type to enforce using MODEL_TIERS constants instead of string literals
declare const ModelTierBrand: unique symbol;
type ModelTierBranded = { readonly [ModelTierBrand]: never };

// Base tier values (internal use only)
type ModelTierValue = "haiku" | "sonnet" | "opus";

// Exported branded type - string literals won't satisfy this
export type ModelTier = ModelTierValue & ModelTierBranded;

// Constants that MUST be used instead of string literals
export const MODEL_TIERS = {
  HAIKU: "haiku" as ModelTier,
  SONNET: "sonnet" as ModelTier,
  OPUS: "opus" as ModelTier,
} as const;

// Branded type for telemetry execution mode
declare const TelemetryModeBrand: unique symbol;
type TelemetryModeBranded = { readonly [TelemetryModeBrand]: never };

type TelemetryModeValue = "direct" | "lazy";

export type TelemetryMode = TelemetryModeValue & TelemetryModeBranded;

export const EXECUTION_MODES = {
  DIRECT: "direct" as TelemetryMode,
  LAZY: "lazy" as TelemetryMode,
} as const;

// Branded type for execution type (LLM vs TypeScript)
declare const ExecutionTypeBrand: unique symbol;
type ExecutionTypeBranded = { readonly [ExecutionTypeBrand]: never };

type ExecutionTypeValue = "llm" | "typescript";

export type ExecutionType = ExecutionTypeValue & ExecutionTypeBranded;

export const EXECUTION_TYPES = {
  LLM: "llm" as ExecutionType,
  TYPESCRIPT: "typescript" as ExecutionType,
} as const;

// Re-export provider types from provider-config
export {
  type ProviderType,
  PROVIDER_TYPES,
  resolveProvider,
  requiresCostTracking,
} from "./utils/provider-config.js";

// Model IDs for OpenRouter (default provider). Update when new models available.
export const MODEL_IDS: Record<ModelTierValue, string> = {
  haiku: "x-ai/grok-4.1-fast",
  sonnet: "google/gemini-3-flash-preview",
  opus: "anthropic/claude-opus-4.5",
};

export function getModelId(tier: ModelTier): string {
  return MODEL_IDS[tier as ModelTierValue];
}

/**
 * Parse a tier name string to a branded ModelTier.
 * Defaults to OPUS if the input is invalid or not provided.
 */
export function parseTierName(name?: string): ModelTier {
  if (!name) return MODEL_TIERS.OPUS;
  switch (name.toLowerCase()) {
    case "haiku":
      return MODEL_TIERS.HAIKU;
    case "sonnet":
      return MODEL_TIERS.SONNET;
    case "opus":
      return MODEL_TIERS.OPUS;
    default:
      return MODEL_TIERS.OPUS;
  }
}

// Set SDK environment variables to use our model IDs
// This ensures internal SDK sub-agents use our configured models
process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = MODEL_IDS.haiku;
process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = MODEL_IDS.sonnet;
process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = MODEL_IDS.opus;

export interface AgentResult {
  success: boolean;
  output: string;
}

/**
 * Standard result type for hook agent checks.
 *
 * All hook agents should return this type (or an extension of it).
 */
export interface CheckResult {
  /** Whether the check passed */
  approved: boolean;
  /** Reason for denial (only present when approved=false) */
  reason?: string;
}

/**
 * Extended result type for stop hook checks.
 *
 * Adds systemMessage for injecting corrective guidance.
 */
export interface StopCheckResult extends CheckResult {
  /** System message to inject when blocking the stop */
  systemMessage?: string;
}

// Off-topic / conversation alignment check result
export interface OffTopicCheckResult {
  decision: "OK" | "INTERVENE";
  feedback?: string;
}

export interface UserMessage {
  text: string;
  messageIndex: number;
}

export interface AssistantMessage {
  text: string;
  messageIndex: number;
}

export interface ConversationContext {
  userMessages: UserMessage[];
  assistantMessages: AssistantMessage[];
  conversationSummary: string;
  lastAssistantMessage: string;
}

