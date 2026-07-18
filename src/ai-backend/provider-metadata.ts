import type { ProviderMetadataState } from "../providers/provider-contract.js";

export function createDefaultProviderMetadata(
  overrides: Partial<ProviderMetadataState> = {}
): ProviderMetadataState {
  return mergeProviderMetadata({
    provider: null,
    runtime: null,
    model: null,
    displayModel: null,
    availableModels: [],
    nativeSessionId: null,
    usage: null,
    context: {
      usedTokens: null,
      maxTokens: null,
      remainingTokens: null,
    },
    compaction: {
      lastCompactedAt: null,
      events: [],
    },
    errors: [],
  }, overrides);
}

export function mergeProviderMetadata(
  existing: ProviderMetadataState,
  incoming: Partial<ProviderMetadataState>
): ProviderMetadataState;
export function mergeProviderMetadata(
  existing: Partial<ProviderMetadataState>,
  incoming: Partial<ProviderMetadataState>
): Partial<ProviderMetadataState>;
export function mergeProviderMetadata(
  existing: Partial<ProviderMetadataState>,
  incoming: Partial<ProviderMetadataState>
): Partial<ProviderMetadataState> {
  return {
    ...existing,
    ...incoming,
    ...(existing.availableModels || incoming.availableModels
      ? { availableModels: incoming.availableModels ?? existing.availableModels ?? [] }
      : {}),
    ...(existing.context || incoming.context
      ? {
          context: {
            usedTokens: null,
            maxTokens: null,
            remainingTokens: null,
            ...(existing.context ?? {}),
            ...(incoming.context ?? {}),
          },
        }
      : {}),
    ...(existing.compaction || incoming.compaction
      ? {
          compaction: {
            lastCompactedAt: null,
            ...(existing.compaction ?? {}),
            ...(incoming.compaction ?? {}),
            events: incoming.compaction?.events ?? existing.compaction?.events ?? [],
          },
        }
      : {}),
    ...(existing.errors || incoming.errors
      ? { errors: incoming.errors ?? existing.errors ?? [] }
      : {}),
  };
}
