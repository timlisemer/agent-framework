import type { TokenUsage } from "../../src/ai-protocol/index.js";
import { numberOrNull, recordFromUnknown } from "../../src/utils/output.js";

type CodexProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

export function normalizeCodexTokenUsage(value: unknown): TokenUsage | null {
  const source = codexUsageSource(value);
  if (!source) return null;
  const promptTokens = numberOrNull(source.input_tokens) ?? numberOrNull(source.prompt_tokens);
  const cachedTokens = numberOrNull(source.cached_input_tokens) ?? numberOrNull(source.cached_tokens);
  const completionTokens = numberOrNull(source.output_tokens) ?? numberOrNull(source.completion_tokens);
  const reasoningTokens = numberOrNull(source.reasoning_output_tokens) ?? numberOrNull(source.reasoning_tokens);
  const totalTokens = numberOrNull(source.total_tokens) ??
    (promptTokens !== null || completionTokens !== null
      ? (promptTokens ?? 0) + (completionTokens ?? 0)
      : null);
  if (
    promptTokens === null &&
    cachedTokens === null &&
    completionTokens === null &&
    reasoningTokens === null &&
    totalTokens === null
  ) {
    return null;
  }
  return {
    promptTokens,
    cachedTokens,
    completionTokens,
    reasoningTokens,
    totalTokens,
  };
}

export function normalizeCodexProviderUsage(value: unknown): CodexProviderUsage | undefined {
  const usage = normalizeCodexTokenUsage(value);
  return usage
    ? {
        ...(usage.promptTokens !== null ? { promptTokens: usage.promptTokens } : {}),
        ...(usage.cachedTokens !== null ? { cachedTokens: usage.cachedTokens } : {}),
        ...(usage.completionTokens !== null ? { completionTokens: usage.completionTokens } : {}),
        ...(usage.reasoningTokens !== null ? { reasoningTokens: usage.reasoningTokens } : {}),
        ...(usage.totalTokens !== null ? { totalTokens: usage.totalTokens } : {}),
      }
    : undefined;
}

export function mapCodexTokenUsage<T>(
  value: unknown,
  convert: (value: number | undefined) => T
): {
  promptTokens: T;
  cachedTokens: T;
  completionTokens: T;
  reasoningTokens: T;
  totalTokens: T;
} | null {
  const usage = normalizeCodexTokenUsage(value);
  return usage
    ? {
        promptTokens: convert(undefinedFromNull(usage.promptTokens)),
        cachedTokens: convert(undefinedFromNull(usage.cachedTokens)),
        completionTokens: convert(undefinedFromNull(usage.completionTokens)),
        reasoningTokens: convert(undefinedFromNull(usage.reasoningTokens)),
        totalTokens: convert(undefinedFromNull(usage.totalTokens)),
      }
    : null;
}

function codexUsageSource(value: unknown): Record<string, unknown> | null {
  const record = recordFromUnknown(value);
  if (Object.keys(record).length === 0) return null;
  return nonEmptyRecord(record.total_token_usage) ??
    nonEmptyRecord(record.usage) ??
    record;
}

function nonEmptyRecord(value: unknown): Record<string, unknown> | null {
  const record = recordFromUnknown(value);
  return Object.keys(record).length > 0 ? record : null;
}

function undefinedFromNull(value: number | null): number | undefined {
  return value === null ? undefined : value;
}
