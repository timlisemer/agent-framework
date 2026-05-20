/**
 * Provider Configuration System
 *
 * Allows flexible configuration of LLM providers per tier and mode.
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
 * - AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME: claude | codex
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
import { providerConfigPath } from "./paths.js";
import type { ModelTier } from "../types.js";
import {
  PROVIDERS,
  PROVIDER_TYPES,
  parseProviderTypeStrict,
  parseSdkRuntimeStrict,
  providerKey,
  tierKey,
} from "../providers/registry.js";
import type {
  ProviderMode,
  ProviderModelSpec,
  ProviderType,
  ProviderTypeValue,
  ResolvedProvider,
  SdkRuntime,
} from "../providers/types.js";

export { PROVIDER_TYPES };
export type { ProviderMode, ProviderType, ProviderTypeValue, ResolvedProvider, SdkRuntime };

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
  providers?: {
    openrouter?: {
      sdkRuntime?: SdkRuntime;
    };
  };
}

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
    providerConfigPath(),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, "utf-8");
        cachedConfig = validateConfigFile(JSON.parse(content), configPath);
        return cachedConfig;
      } catch (err) {
        if (err instanceof Error) {
          throw new Error(`Invalid agent-framework provider config at ${configPath}: ${err.message}`);
        }
        throw err;
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

function validateConfigFile(value: unknown, source: string): ProviderConfigFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("config must be a JSON object");
  }
  const raw = value as ProviderConfigFile;
  validateProviderValue(raw.default, `${source}.default`);
  validateProviderValue(raw.modes?.direct, `${source}.modes.direct`);
  validateProviderValue(raw.modes?.sdk, `${source}.modes.sdk`);
  for (const tier of ["haiku", "sonnet", "opus"] as const) {
    validateProviderValue(raw.tiers?.[tier]?.direct, `${source}.tiers.${tier}.direct`);
    validateProviderValue(raw.tiers?.[tier]?.sdk, `${source}.tiers.${tier}.sdk`);
  }
  if (raw.providers?.openrouter?.sdkRuntime !== undefined) {
    parseSdkRuntimeStrict(raw.providers.openrouter.sdkRuntime, `${source}.providers.openrouter.sdkRuntime`);
  }
  return raw;
}

function validateProviderValue(value: unknown, source: string): void {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw new Error(`${source} must be a provider string`);
  }
  parseProviderTypeStrict(value, source);
}

function providerFromEnv(name: string): ProviderType | null {
  const value = process.env[name];
  return value ? parseProviderTypeStrict(value, name) : null;
}

function providerFromConfig(value: ProviderTypeValue | undefined, source: string): ProviderType | null {
  return value ? parseProviderTypeStrict(value, source) : null;
}

function resolveOpenRouterSdkRuntime(config: ProviderConfigFile): SdkRuntime {
  const envValue = process.env.AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME;
  if (envValue) return parseSdkRuntimeStrict(envValue, "AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME");
  return config.providers?.openrouter?.sdkRuntime ?? "codex";
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
 * @throws Error if an environment or config provider value is invalid
 */
export function resolveProvider(
  tier: ModelTier,
  mode: ProviderMode
): ResolvedProvider {
  const config = loadConfigFile();
  const tierName = tierKey(tier);

  // 1. Mode-specific env var
  const modeEnvKey = mode === "direct"
    ? "AGENT_FRAMEWORK_DIRECT_PROVIDER"
    : "AGENT_FRAMEWORK_SDK_PROVIDER";
  let provider = providerFromEnv(modeEnvKey);

  // 2. Config file tier+mode specific
  if (!provider && config.tiers) {
    const tierConfig = config.tiers[tierName];
    if (tierConfig) {
      provider = providerFromConfig(tierConfig[mode], `tiers.${tierName}.${mode}`);
    }
  }

  // 3. Config file mode specific
  if (!provider && config.modes) {
    provider = providerFromConfig(config.modes[mode], `modes.${mode}`);
  }

  // 4. Global env var
  if (!provider) {
    provider = providerFromEnv("AGENT_FRAMEWORK_PROVIDER");
  }

  // 5. Config file default
  if (!provider) {
    provider = providerFromConfig(config.default, "default");
  }

  // 6. Hardcoded default
  if (!provider) {
    provider = PROVIDER_TYPES.OPENROUTER;
  }

  const definition = PROVIDERS[providerKey(provider)];
  const model: ProviderModelSpec = definition.models[tierName] ?? definition.models.opus;
  const sdkRuntime = mode === "sdk"
    ? provider === PROVIDER_TYPES.OPENROUTER
      ? resolveOpenRouterSdkRuntime(config)
      : definition.defaultSdkRuntime
    : undefined;

  return {
    type: provider,
    mode,
    modelId: model.id,
    reasoningEffort: model.reasoningEffort,
    sdkRuntime,
    costTracking: mode === "direct" ? definition.costTracking : "none",
  };
}

export function resolveProviderForType(
  provider: ProviderType,
  tier: ModelTier,
  mode: ProviderMode
): ResolvedProvider {
  const config = loadConfigFile();
  const definition = PROVIDERS[providerKey(provider)];
  const model: ProviderModelSpec = definition.models[tierKey(tier)] ?? definition.models.opus;
  const sdkRuntime = mode === "sdk"
    ? provider === PROVIDER_TYPES.OPENROUTER
      ? resolveOpenRouterSdkRuntime(config)
      : definition.defaultSdkRuntime
    : undefined;
  return {
    type: provider,
    mode,
    modelId: model.id,
    reasoningEffort: model.reasoningEffort,
    sdkRuntime,
    costTracking: mode === "direct" ? definition.costTracking : "none",
  };
}

/**
 * Check if a provider type requires cost tracking.
 *
 * - openrouter direct: Requires generation ID for async cost fetching
 * - subscription providers and SDK mode: No provider-cost lookup
 */
export function requiresCostTracking(provider: ProviderType, mode: ProviderMode = "direct"): boolean {
  return mode === "direct" && PROVIDERS[providerKey(provider)].costTracking === "openrouter-generation";
}
