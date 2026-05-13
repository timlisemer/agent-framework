export type ProviderTypeValue =
  | "openrouter"
  | "claude-subscription"
  | "openai-subscription";

declare const ProviderTypeBrand: unique symbol;
type ProviderTypeBranded = { readonly [ProviderTypeBrand]: never };

export type ProviderType = ProviderTypeValue & ProviderTypeBranded;

export type ProviderMode = "direct" | "sdk";
export type ModelTierKey = "haiku" | "sonnet" | "opus";
export type SdkRuntime = "claude" | "codex";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CostTrackingMode = "openrouter-generation" | "none";

export interface ProviderModelSpec {
  id: string;
  reasoningEffort?: ReasoningEffort;
}

export interface ProviderDefinition {
  type: ProviderType;
  displayName: string;
  costTracking: CostTrackingMode;
  models: Record<ModelTierKey, ProviderModelSpec>;
  defaultSdkRuntime?: SdkRuntime;
}

export interface ResolvedProvider {
  type: ProviderType;
  mode: ProviderMode;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  sdkRuntime?: SdkRuntime;
  costTracking: CostTrackingMode;
}

