import {
  artifactValueReferenceFromValue,
  escapedArtifactLiteral,
  type ArtifactRef,
} from "../protocol/artifacts.js";
import type { JsonValue } from "../protocol/common.js";
import { canonicalJson, canonicalJsonEqual } from "../protocol/canonical-json.js";
import { digestScenarioValue } from "../protocol/digest.js";
import type { ScenarioRecord } from "../protocol/records.js";

export type ArtifactValueReader = {
  readArtifact(
    runId: string,
    requested: ArtifactRef,
    maximumBytes: number,
  ): Promise<{ artifact: ArtifactRef; bytes: Uint8Array }>;
};

/** Hydrate canonical artifact-reference substitutions back into JSON values. */
export async function hydrateArtifactValues(
  reader: ArtifactValueReader,
  runId: string,
  value: JsonValue,
  artifacts: ReadonlyMap<string, ArtifactRef>,
  cache: Map<string, JsonValue> = new Map(),
  trustedReferences: ReadonlySet<string> = new Set(),
): Promise<JsonValue> {
  const literal = escapedArtifactLiteral(value);
  if (literal !== undefined) return literal as JsonValue;
  const reference = artifactReference(value, artifacts, trustedReferences);
  if (reference) {
    const cached = cache.get(reference.digest);
    if (cached !== undefined) return cached;
    const loaded = await reader.readArtifact(runId, reference, reference.byteLength);
    const hydrated = JSON.parse(Buffer.from(loaded.bytes).toString("utf8")) as JsonValue;
    if (digestScenarioValue(hydrated) !== reference.digest) {
      throw new Error(`Hydrated artifact digest mismatch: ${reference.digest}`);
    }
    cache.set(reference.digest, hydrated);
    return hydrated;
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map((child) =>
      hydrateArtifactValues(reader, runId, child, artifacts, cache, trustedReferences)
    ));
  }
  if (typeof value === "object" && value !== null) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, child]) => [
      key,
      await hydrateArtifactValues(reader, runId, child, artifacts, cache, trustedReferences),
    ] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

function artifactReference(
  value: JsonValue,
  artifacts: ReadonlyMap<string, ArtifactRef>,
  trustedReferences: ReadonlySet<string>,
): ArtifactRef | undefined {
  const reference = artifactValueReferenceFromValue(value);
  if (!reference || !trustedReferences.has(artifactValueReferenceKey(reference))) return undefined;
  const persisted = reference.$scenarioArtifactValue.artifact;
  const linked = artifacts.get(persisted.digest);
  if (!linked || linked.artifactId !== persisted.artifactId) return undefined;
  return linked;
}

export function trustedArtifactValueReferences(records: readonly ScenarioRecord[]): Set<string> {
  const trusted = new Set<string>();
  for (const record of records) {
    collectTrustedReferences(record.payload, [], record, trusted);
  }
  return trusted;
}

function collectTrustedReferences(
  value: JsonValue,
  path: string[],
  record: ScenarioRecord,
  trusted: Set<string>,
): void {
  if (escapedArtifactLiteral(value) !== undefined) return;
  const reference = artifactValueReferenceFromValue(value);
  if (reference) {
    const provenance = reference.$scenarioArtifactValue;
    if (
      provenance.commandId === record.commandId &&
      provenance.eventType === record.eventType &&
      canonicalJsonEqual(provenance.path, path)
    ) {
      trusted.add(artifactValueReferenceKey(reference));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => collectTrustedReferences(child, [...path, String(index)], record, trusted));
  } else if (typeof value === "object" && value !== null) {
    for (const [key, child] of Object.entries(value)) {
      collectTrustedReferences(child, [...path, key], record, trusted);
    }
  }
}

function artifactValueReferenceKey(reference: NonNullable<ReturnType<typeof artifactValueReferenceFromValue>>): string {
  return canonicalJson(reference.$scenarioArtifactValue);
}
