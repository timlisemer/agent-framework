import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  requiresCostTracking,
  resolveProvider,
  resetProviderConfig,
  PROVIDER_TYPES,
} from "../../src/utils/provider-config.js";
import { MODEL_TIERS } from "../../src/types.js";

describe("requiresCostTracking", () => {
  it("returns true for OPENROUTER provider", () => {
    expect(requiresCostTracking(PROVIDER_TYPES.OPENROUTER)).toBe(true);
  });

  it("returns false for CLAUDE_SUBSCRIPTION provider", () => {
    expect(requiresCostTracking(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION)).toBe(false);
  });
});

describe("resolveProvider", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "AGENT_FRAMEWORK_PROVIDER",
    "AGENT_FRAMEWORK_DIRECT_PROVIDER",
    "AGENT_FRAMEWORK_SDK_PROVIDER",
  ];

  beforeEach(() => {
    // Save and clear relevant env vars
    for (const key of envKeys) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    resetProviderConfig();
  });

  afterEach(() => {
    // Restore env vars
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    resetProviderConfig();
  });

  it("returns openrouter as default provider", () => {
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.OPENROUTER);
  });

  it("respects AGENT_FRAMEWORK_PROVIDER env var", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION);
  });

  it("respects AGENT_FRAMEWORK_DIRECT_PROVIDER for direct mode", () => {
    process.env.AGENT_FRAMEWORK_DIRECT_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.SONNET, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION);
  });

  it("respects AGENT_FRAMEWORK_SDK_PROVIDER for sdk mode", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.OPUS, "sdk");
    expect(result.type).toBe(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION);
  });

  it("mode-specific env var overrides global env var", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "openrouter";
    process.env.AGENT_FRAMEWORK_DIRECT_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION);
  });

  it("returns correct model IDs for openrouter provider", () => {
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.OPENROUTER);
    // OpenRouter model IDs contain a slash (org/model format)
    expect(result.modelId).toContain("/");
  });

  it("returns correct model IDs for claude-subscription provider", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.modelId).toContain("claude-");
  });

  it("invalid env var value falls through to default", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "invalid-provider";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    expect(result.type).toBe(PROVIDER_TYPES.OPENROUTER);
  });

  it("handles all three tiers", () => {
    const haiku = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    const sonnet = resolveProvider(MODEL_TIERS.SONNET, "direct");
    const opus = resolveProvider(MODEL_TIERS.OPUS, "direct");
    // Each tier should resolve to a different model ID
    expect(new Set([haiku.modelId, sonnet.modelId, opus.modelId]).size).toBe(3);
  });

  it("global env var does not override mode-specific env var", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "openrouter";
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "claude-subscription";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.OPUS, "sdk");
    expect(result.type).toBe(PROVIDER_TYPES.CLAUDE_SUBSCRIPTION);
  });
});
