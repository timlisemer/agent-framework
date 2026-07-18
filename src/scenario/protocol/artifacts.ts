import { z } from "zod";
import { idSchema, sha256DigestSchema, visibilitySchema, type JsonValue } from "./common.js";

export const artifactRefSchema = z.object({
  artifactId: idSchema.regex(/^[a-f0-9]{64}$/, "Artifact IDs must be SHA-256 hex digests"),
  digest: sha256DigestSchema,
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
  visibility: visibilitySchema,
  preview: z.string().optional(),
}).strict();
export type ArtifactRef = z.infer<typeof artifactRefSchema>;

const artifactValueProvenanceSchema = z.object({
  version: z.literal(1),
  commandId: idSchema,
  eventType: z.string().min(1),
  path: z.array(z.string()),
  artifact: artifactRefSchema,
}).strict();

export const artifactValueReferenceSchema = z.object({
  $scenarioArtifactValue: artifactValueProvenanceSchema,
}).strict();
export type ArtifactValueReference = z.infer<typeof artifactValueReferenceSchema>;

const artifactLiteralValueSchema = z.object({
  $scenarioLiteralValue: z.unknown(),
}).strict();

const ARTIFACT_STRING_REFERENCE = /\n\[scenario-artifact-value (\{.*\})\]$/;
const ARTIFACT_LITERAL_PREFIX = "\u001escenario-literal:";

/** Extract a framework-authored artifact substitution. Literal strings are never references. */
export function artifactValueReferenceFromValue(value: unknown): ArtifactValueReference | undefined {
  if (typeof value === "string") {
    const serialized = value.match(ARTIFACT_STRING_REFERENCE)?.[1];
    if (!serialized) return undefined;
    try {
      const provenance = artifactValueProvenanceSchema.safeParse(JSON.parse(serialized));
      return provenance.success ? { $scenarioArtifactValue: provenance.data } : undefined;
    } catch {
      return undefined;
    }
  }
  const parsed = artifactValueReferenceSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function artifactDigestFromValue(value: unknown): string | undefined {
  return artifactValueReferenceFromValue(value)?.$scenarioArtifactValue.artifact.digest;
}

/** Reserved envelopes supplied as data are persisted inside a literal escape envelope. */
export function isReservedArtifactValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.startsWith(ARTIFACT_LITERAL_PREFIX) || ARTIFACT_STRING_REFERENCE.test(value);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return "$scenarioArtifactValue" in value || "$scenarioLiteralValue" in value;
}

export function escapedArtifactLiteral(value: unknown): unknown | undefined {
  if (typeof value === "string" && value.startsWith(ARTIFACT_LITERAL_PREFIX)) {
    return value.slice(ARTIFACT_LITERAL_PREFIX.length);
  }
  const parsed = artifactLiteralValueSchema.safeParse(value);
  return parsed.success ? parsed.data.$scenarioLiteralValue : undefined;
}

export function artifactStringReference(
  reference: ArtifactValueReference,
  preview: string,
): string {
  return `${preview}\n[scenario-artifact-value ${JSON.stringify(reference.$scenarioArtifactValue)}]`;
}

export function escapeArtifactLiteralValue(value: JsonValue): JsonValue {
  return typeof value === "string"
    ? `${ARTIFACT_LITERAL_PREFIX}${value}`
    : { $scenarioLiteralValue: value };
}

export const redactedValueSchema = z.object({
  redacted: z.literal(true),
  reason: z.string().min(1),
  originalType: z.string().min(1),
  shape: z.string().optional(),
}).strict();
export type RedactedValue = z.infer<typeof redactedValueSchema>;
