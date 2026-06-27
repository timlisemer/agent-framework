import type { AiProviderMetadataState } from "../ai-protocol/index.js";

export function createDefaultProviderMetadata(
  overrides: Partial<AiProviderMetadataState> = {}
): AiProviderMetadataState {
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
  existing: AiProviderMetadataState,
  incoming: Partial<AiProviderMetadataState>
): AiProviderMetadataState;
export function mergeProviderMetadata(
  existing: Partial<AiProviderMetadataState>,
  incoming: Partial<AiProviderMetadataState>
): Partial<AiProviderMetadataState>;
export function mergeProviderMetadata(
  existing: Partial<AiProviderMetadataState>,
  incoming: Partial<AiProviderMetadataState>
): Partial<AiProviderMetadataState> {
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
