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

  it("returns false for OPENAI_SUBSCRIPTION provider", () => {
    expect(requiresCostTracking(PROVIDER_TYPES.OPENAI_SUBSCRIPTION)).toBe(false);
  });

  it("returns false for OpenRouter SDK mode", () => {
    expect(requiresCostTracking(PROVIDER_TYPES.OPENROUTER, "sdk")).toBe(false);
  });
});

describe("resolveProvider", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const envKeys = [
    "AGENT_FRAMEWORK_PROVIDER",
    "AGENT_FRAMEWORK_DIRECT_PROVIDER",
    "AGENT_FRAMEWORK_SDK_PROVIDER",
    "AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME",
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

  it("respects openai-subscription provider", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "openai-subscription";
    resetProviderConfig();
    const haiku = resolveProvider(MODEL_TIERS.HAIKU, "direct");
    const sonnet = resolveProvider(MODEL_TIERS.SONNET, "direct");
    const opus = resolveProvider(MODEL_TIERS.OPUS, "direct");
    expect(haiku.type).toBe(PROVIDER_TYPES.OPENAI_SUBSCRIPTION);
    expect(haiku.modelId).toBe("gpt-5.4-mini");
    expect(sonnet.modelId).toBe("gpt-5.5");
    expect(opus.modelId).toBe("gpt-5.5");
    expect(opus.reasoningEffort).toBe("xhigh");
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

  it("supports OpenRouter SDK mode with Codex runtime by default", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openrouter";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.OPUS, "sdk");
    expect(result.type).toBe(PROVIDER_TYPES.OPENROUTER);
    expect(result.sdkRuntime).toBe("codex");
    expect(result.costTracking).toBe("none");
  });

  it("supports OpenRouter SDK mode with Claude runtime override", () => {
    process.env.AGENT_FRAMEWORK_SDK_PROVIDER = "openrouter";
    process.env.AGENT_FRAMEWORK_OPENROUTER_SDK_RUNTIME = "claude";
    resetProviderConfig();
    const result = resolveProvider(MODEL_TIERS.OPUS, "sdk");
    expect(result.sdkRuntime).toBe("claude");
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

  it("throws for invalid env var value", () => {
    process.env.AGENT_FRAMEWORK_PROVIDER = "invalid-provider";
    resetProviderConfig();
    expect(() => resolveProvider(MODEL_TIERS.HAIKU, "direct")).toThrow(/Invalid provider/);
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
