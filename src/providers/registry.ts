import type {
  ModelTierKey,
  ProviderDefinition,
  ProviderType,
  ProviderTypeValue,
  SdkRuntime,
} from "./types.js";

export const PROVIDER_TYPES = {
  OPENROUTER: "openrouter" as ProviderType,
  CLAUDE_SUBSCRIPTION: "claude-subscription" as ProviderType,
  OPENAI_SUBSCRIPTION: "openai-subscription" as ProviderType,
} as const;

export const PROVIDERS = {
  openrouter: {
    type: PROVIDER_TYPES.OPENROUTER,
    displayName: "OpenRouter",
    costTracking: "openrouter-generation",
    defaultSdkRuntime: "claude",
    models: {
      haiku: { id: "x-ai/grok-4.1-fast" },
      sonnet: { id: "google/gemini-3-flash-preview" },
      opus: { id: "anthropic/claude-opus-4.5" },
    },
  },
  "claude-subscription": {
    type: PROVIDER_TYPES.CLAUDE_SUBSCRIPTION,
    displayName: "Claude subscription",
    costTracking: "none",
    defaultSdkRuntime: "claude",
    models: {
      haiku: { id: "claude-haiku-4-5" },
      sonnet: { id: "claude-sonnet-4-5" },
      opus: { id: "claude-opus-4-5" },
    },
  },
  "openai-subscription": {
    type: PROVIDER_TYPES.OPENAI_SUBSCRIPTION,
    displayName: "OpenAI subscription",
    costTracking: "none",
    defaultSdkRuntime: "codex",
    models: {
      haiku: { id: "gpt-5.4-mini" },
      sonnet: { id: "gpt-5.5" },
      opus: { id: "gpt-5.5", reasoningEffort: "xhigh" },
    },
  },
} as const satisfies Record<ProviderTypeValue, ProviderDefinition>;

export function isProviderTypeValue(value: string): value is ProviderTypeValue {
  return value === "openrouter" ||
    value === "claude-subscription" ||
    value === "openai-subscription";
}

export function parseProviderTypeStrict(value: string, source: string): ProviderType {
  const normalized = value.toLowerCase();
  if (!isProviderTypeValue(normalized)) {
    throw new Error(
      `Invalid provider '${value}' from ${source}. Expected one of: openrouter, claude-subscription, openai-subscription.`
    );
  }
  return PROVIDERS[normalized].type;
}

export function providerKey(provider: ProviderType): ProviderTypeValue {
  return provider as ProviderTypeValue;
}

export function tierKey(tier: unknown): ModelTierKey {
  if (tier === "haiku" || tier === "sonnet" || tier === "opus") return tier;
  return "opus";
}

export function parseSdkRuntimeStrict(value: string, source: string): SdkRuntime {
  const normalized = value.toLowerCase();
  if (normalized !== "claude" && normalized !== "codex") {
    throw new Error(`Invalid SDK runtime '${value}' from ${source}. Expected 'claude' or 'codex'.`);
  }
  return normalized;
}

