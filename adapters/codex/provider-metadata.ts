import type {
  ProviderMetadata,
  ProviderMetadataState,
} from "../../src/providers/provider-contract.js";
import type { ProviderMetadataExtractionInput } from "../../src/adapter/types.js";
import { parseJsonlLines } from "../../src/utils/file-io.js";
import { isRecord, nonEmptyStringField, numberOrNull, recordFromUnknown, stringField } from "../../src/utils/output.js";

export function extractProviderMetadata(
  input: ProviderMetadataExtractionInput
): Partial<ProviderMetadataState> {
  let usedTokens: number | null = null;
  let maxTokens: number | null = null;
  let remainingTokens: number | null = null;
  let lastCompactedAt: string | null = null;
  const compactionEvents: ProviderMetadata[] = [];

  input.rawLines.forEach((line, index) => {
    const raw = recordFromUnknown(parseJsonlLines<unknown>([line])[0]);
    if (Object.keys(raw).length === 0) return;
    const payload = isRecord(raw.payload) ? raw.payload : raw;
    const payloadType = stringField(payload, "type") ?? stringField(raw, "type") ?? "";

    usedTokens = newestNumber(payload, [
      "used_tokens",
      "usedTokens",
      "context_used_tokens",
      "total_tokens",
      "totalTokens",
    ]) ?? usedTokens;
    maxTokens = newestNumber(payload, [
      "max_tokens",
      "maxTokens",
      "context_window",
      "contextWindow",
      "context_window_tokens",
      "max_context_tokens",
    ]) ?? maxTokens;
    remainingTokens = newestNumber(payload, [
      "remaining_tokens",
      "remainingTokens",
      "remaining_context_tokens",
      "remainingContextTokens",
    ]) ?? remainingTokens;

    if (isCompactionPayload(payloadType, payload)) {
      const timestamp = nonEmptyStringField(raw, "timestamp") ??
        nonEmptyStringField(raw, "created_at") ??
        nonEmptyStringField(raw, "createdAt");
      const reason = nonEmptyStringField(payload, "reason");
      const summary = nonEmptyStringField(payload, "summary");
      lastCompactedAt = timestamp ?? lastCompactedAt;
      compactionEvents.push({
        type: payloadType || "compaction",
        sourceLine: index + 1,
        ...(timestamp ? { timestamp } : {}),
        ...(reason ? { reason } : {}),
        ...(summary ? { summary } : {}),
      });
    }
  });

  const patch: Partial<ProviderMetadataState> = {};
  if (usedTokens !== null || maxTokens !== null || remainingTokens !== null) {
    patch.context = { usedTokens, maxTokens, remainingTokens };
  }
  if (lastCompactedAt !== null || compactionEvents.length > 0) {
    patch.compaction = { lastCompactedAt, events: compactionEvents };
  }
  return patch;
}

function newestNumber(root: Record<string, unknown>, keys: readonly string[]): number | null {
  const found = findNumber(root, new Set(keys));
  return found === undefined ? null : found;
}

function findNumber(value: unknown, keys: ReadonlySet<string>): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, item] of Object.entries(value)) {
    const numeric = numberOrNull(item);
    if (keys.has(key) && numeric !== null) return numeric;
  }
  for (const item of Object.values(value)) {
    const nested = findNumber(item, keys);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function isCompactionPayload(type: string, payload: Record<string, unknown>): boolean {
  if (/compact|compaction/i.test(type)) return true;
  if (payload.compacted === true) return true;
  if (typeof payload.event === "string" && /compact|compaction/i.test(payload.event)) return true;
  return false;
}
