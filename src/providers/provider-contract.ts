import { z } from "zod";
import type { JsonValue, RuntimeHomeDescriptor } from "../scenario/protocol/common.js";
import type { SdkRuntime } from "./types.js";

export const sdkRuntimeEnvironmentValues = ["isolated", "user"] as const;
export const sdkRuntimeEnvironmentSchema = z.enum(sdkRuntimeEnvironmentValues);
export type SdkRuntimeEnvironment = z.infer<typeof sdkRuntimeEnvironmentSchema>;
export type SdkRuntimeHome = "native" | "managed";

const nativeProviderRuntimeHomeSchema = z.object({
  kind: z.literal("native"),
  configuration: z.object({}).strict(),
}).strict();
const managedProviderRuntimeHomeSchema = z.object({
  kind: z.literal("managed"),
  configuration: z.object({ profile: z.literal("default") }).strict(),
}).strict();
export const providerRuntimeHomeDescriptorSchema = z.discriminatedUnion("kind", [
  nativeProviderRuntimeHomeSchema,
  managedProviderRuntimeHomeSchema,
]);
export type ProviderRuntimeHomeDescriptor = z.infer<typeof providerRuntimeHomeDescriptorSchema>;

export type ProviderGatewayPolicy = {
  sdkRuntimeEnvironment: SdkRuntimeEnvironment;
  runtimeHome: ProviderRuntimeHomeDescriptor;
};

export function parseProviderGatewayPolicy(input: {
  sdkRuntimeEnvironment: string;
  runtimeHome: RuntimeHomeDescriptor;
}): ProviderGatewayPolicy {
  return {
    sdkRuntimeEnvironment: sdkRuntimeEnvironmentSchema.parse(input.sdkRuntimeEnvironment),
    runtimeHome: providerRuntimeHomeDescriptorSchema.parse(input.runtimeHome),
  };
}

export type TokenUsage = {
  promptTokens: number | null;
  cachedTokens: number | null;
  completionTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

export type ProviderMetadata = Record<string, JsonValue>;

export type ProviderError = {
  code: "cancelled" | "invalid_request" | "not_found" | "conflict" | "runtime_error";
  message: string;
  recoverable: boolean;
  metadata?: ProviderMetadata;
};

export type ProviderMetadataState = {
  provider: string | null;
  runtime: SdkRuntime | null;
  model: string | null;
  displayModel: string | null;
  availableModels: Array<{ tier: string; id: string; displayName: string | null }>;
  nativeSessionId: string | null;
  usage: TokenUsage | null;
  context: {
    usedTokens: number | null;
    maxTokens: number | null;
    remainingTokens: number | null;
  };
  compaction: {
    lastCompactedAt: string | null;
    events: ProviderMetadata[];
  };
  errors: ProviderError[];
};

export type ProviderSessionConfig = {
  model: string | null;
  workingDir: string | null;
  systemPrompt: string | null;
  continuable: boolean;
  sdkRuntimeEnvironment: SdkRuntimeEnvironment;
  sdkRuntimeHome?: SdkRuntimeHome;
};

export type ProviderToolOutputBlock =
  | { type: "text"; text: string }
  | { type: "json"; value: unknown };
