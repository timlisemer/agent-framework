import type { TokenUsage } from "../../src/providers/provider-contract.js";
import { numberOrNull, recordFromUnknown } from "../../src/utils/output.js";

export function normalizeClaudeAiUsage(usage: unknown, modelUsage?: unknown): TokenUsage | null {
  if (
    (usage === null || usage === undefined || typeof usage !== "object") &&
    (modelUsage === null || modelUsage === undefined || typeof modelUsage !== "object")
  ) return null;
  const data = recordFromUnknown(usage);
  const promptTokens = numberOrNull(data.input_tokens);
  const completionTokens = numberOrNull(data.output_tokens);
  const directCachedTokens = numberOrNull(data.cache_read_input_tokens);
  const modelCachedTokens = Object.values(recordFromUnknown(modelUsage)).reduce<number>(
    (total, model) => total + (numberOrNull(recordFromUnknown(model).cacheReadInputTokens) ?? 0),
    0,
  );
  const cachedTokens = directCachedTokens === null || directCachedTokens === 0
    ? modelCachedTokens || directCachedTokens
    : directCachedTokens;
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens: null,
    totalTokens: promptTokens === null && completionTokens === null
      ? null
      : (promptTokens ?? 0) + (completionTokens ?? 0),
  };
}
