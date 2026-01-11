/**
 * Provider Configuration System
 *
 * Allows flexible configuration of LLM providers per tier and mode:
 * - openrouter: Track costs via generation IDs, show on LLM cost dashboard
 * - claude-subscription: Track everything EXCEPT cost, exclude from LLM cost dashboard
 *
 * ## Configuration Priority
 *
 * 1. Environment variables (highest priority)
 * 2. Config file (.agent-framework.json)
 * 3. Default (openrouter)
 *
 * ## Environment Variables
 *
 * - AGENT_FRAMEWORK_PROVIDER: Global default provider
 * - AGENT_FRAMEWORK_DIRECT_PROVIDER: Override for direct API mode
 * - AGENT_FRAMEWORK_SDK_PROVIDER: Override for SDK mode
 *
 * ## Config File Example
 *
 * ```json
 * {
 *   "default": "openrouter",
 *   "modes": {
 *     "sdk": "claude-subscription"
 *   }
 * }
 * ```
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { ModelTier } from "../types.js";

// Branded type to enforce using constants
declare const ProviderTypeBrand: unique symbol;
type ProviderTypeBranded = { readonly [ProviderTypeBrand]: never };

type ProviderTypeValue = "openrouter" | "claude-subscription";

export type ProviderType = ProviderTypeValue & ProviderTypeBranded;

export const PROVIDER_TYPES = {
  OPENROUTER: "openrouter" as ProviderType,
  CLAUDE_SUBSCRIPTION: "claude-subscription" as ProviderType,
} as const;

/**
 * Configuration file schema
 */
interface ProviderConfigFile {
  default?: ProviderTypeValue;
  modes?: {
    direct?: ProviderTypeValue;
    sdk?: ProviderTypeValue;
  };
  tiers?: {
    haiku?: {
      direct?: ProviderTypeValue;
      sdk?: ProviderTypeValue;
    };
    sonnet?: {
      direct?: ProviderTypeValue;
      sdk?: ProviderTypeValue;
    };
    opus?: {
      direct?: ProviderTypeValue;
      sdk?: ProviderTypeValue;
    };
  };
}

/**
 * Resolved provider configuration for a specific tier+mode combination
 */
export interface ResolvedProvider {
  type: ProviderType;
  modelId: string;
}

// Model IDs for Claude subscription (native Anthropic format)
const SUBSCRIPTION_MODEL_IDS: Record<string, string> = {
  haiku: "claude-3-5-haiku-20241022",
  sonnet: "claude-sonnet-4-20250514",
  opus: "claude-opus-4-20250514",
};

// Model IDs for OpenRouter (from types.ts, duplicated here to avoid circular deps)
const OPENROUTER_MODEL_IDS: Record<string, string> = {
  haiku: "x-ai/grok-4.1-fast",
  sonnet: "google/gemini-3-flash-preview",
  opus: "anthropic/claude-opus-4.5",
};

// Cached config to avoid re-reading file
let cachedConfig: ProviderConfigFile | null = null;

/**
 * Load configuration from file.
 *
 * Searches in order:
 * 1. .agent-framework.json in current working directory
 * 2. ~/.config/agent-framework/config.json
 */
function loadConfigFile(): ProviderConfigFile {
  if (cachedConfig !== null) {
    return cachedConfig;
  }

  const configPaths = [
    join(process.cwd(), ".agent-framework.json"),
    join(homedir(), ".config", "agent-framework", "config.json"),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        cachedConfig = JSON.parse(content) as ProviderConfigFile;
        return cachedConfig;
      } catch {
        // Invalid JSON, continue to next path
      }
    }
  }

  // No config file found, return empty
  cachedConfig = {};
  return cachedConfig;
}

/**
 * Reset cached config (useful for testing).
 * @internal
 */
export function resetProviderConfig(): void {
  cachedConfig = null;
}

/**
 * Parse a provider string into a branded ProviderType.
 * Returns null if invalid.
 */
function parseProviderType(value: string | undefined): ProviderType | null {
  if (!value) return null;
  switch (value.toLowerCase()) {
    case "openrouter":
      return PROVIDER_TYPES.OPENROUTER;
    case "claude-subscription":
      return PROVIDER_TYPES.CLAUDE_SUBSCRIPTION;
    default:
      return null;
  }
}

/**
 * Resolve the provider for a given tier and mode.
 *
 * Resolution order (highest to lowest priority):
 * 1. Mode-specific env var (AGENT_FRAMEWORK_DIRECT_PROVIDER or AGENT_FRAMEWORK_SDK_PROVIDER)
 * 2. Config file tier+mode specific (tiers.opus.sdk)
 * 3. Config file mode specific (modes.sdk)
 * 4. Global env var (AGENT_FRAMEWORK_PROVIDER)
 * 5. Config file default
 * 6. Hardcoded default (openrouter)
 *
 * @throws Error if SDK mode with openrouter (not supported)
 */
export function resolveProvider(
  tier: ModelTier,
  mode: "direct" | "sdk"
): ResolvedProvider {
  const config = loadConfigFile();
  const tierKey = tier as string;

  // 1. Mode-specific env var
  const modeEnvKey = mode === "direct"
    ? "AGENT_FRAMEWORK_DIRECT_PROVIDER"
    : "AGENT_FRAMEWORK_SDK_PROVIDER";
  let provider = parseProviderType(process.env[modeEnvKey]);

  // 2. Config file tier+mode specific
  if (!provider && config.tiers) {
    const tierConfig = config.tiers[tierKey as keyof typeof config.tiers];
    if (tierConfig) {
      provider = parseProviderType(tierConfig[mode]);
    }
  }

  // 3. Config file mode specific
  if (!provider && config.modes) {
    provider = parseProviderType(config.modes[mode]);
  }

  // 4. Global env var
  if (!provider) {
    provider = parseProviderType(process.env.AGENT_FRAMEWORK_PROVIDER);
  }

  // 5. Config file default
  if (!provider) {
    provider = parseProviderType(config.default);
  }

  // 6. Hardcoded default
  if (!provider) {
    provider = PROVIDER_TYPES.OPENROUTER;
  }

  // Validate: SDK mode with openrouter is not supported
  if (mode === "sdk" && provider === PROVIDER_TYPES.OPENROUTER) {
    throw new Error(
      "SDK mode does not support OpenRouter provider. " +
      "Claude Code subprocess cannot use custom base URLs. " +
      "Use 'claude-subscription' for SDK mode by setting " +
      "AGENT_FRAMEWORK_SDK_PROVIDER=claude-subscription"
    );
  }

  // Get model ID based on provider
  const modelId = provider === PROVIDER_TYPES.CLAUDE_SUBSCRIPTION
    ? SUBSCRIPTION_MODEL_IDS[tierKey] ?? SUBSCRIPTION_MODEL_IDS.opus
    : OPENROUTER_MODEL_IDS[tierKey] ?? OPENROUTER_MODEL_IDS.opus;

  return { type: provider, modelId };
}

/**
 * Check if a provider type requires cost tracking.
 *
 * - openrouter: Requires generation ID for async cost fetching
 * - claude-subscription: No cost tracking (included in subscription)
 */
export function requiresCostTracking(provider: ProviderType): boolean {
  return provider === PROVIDER_TYPES.OPENROUTER;
}
