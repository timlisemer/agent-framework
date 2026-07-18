import { z } from "zod";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(z.string(), jsonValueSchema),
]));

export function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? null : JSON.parse(serialized) as JsonValue;
}

export function toJsonObject(value: unknown): Record<string, JsonValue> {
  const cleaned = toJsonValue(value);
  return cleaned && typeof cleaned === "object" && !Array.isArray(cleaned) ? cleaned : {};
}

export const idSchema = z.string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/, "IDs must be path-safe protocol identifiers");
export const sha256DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
/** Canonical protocol timestamps are ISO-8601 datetimes with an explicit UTC offset. */
export const timestampSchema = z.iso.datetime({ offset: true });

export const scenarioStoragePolicyValues = ["durable", "ephemeral"] as const;
export const scenarioStoragePolicySchema = z.enum(scenarioStoragePolicyValues);
export type ScenarioStoragePolicy = z.infer<typeof scenarioStoragePolicySchema>;

export const scenarioVisibilityValues = [
  "public",
  "localSensitive",
  "authorizedSensitive",
  "redacted",
  "artifactReference",
] as const;
export const visibilitySchema = z.enum(scenarioVisibilityValues);
export type ScenarioVisibility = z.infer<typeof visibilitySchema>;

export const runSourceKindValues = ["hostHook", "providerSdk", "scenarioFixture", "gateway"] as const;
export const runSourceSchema = z.object({
  kind: z.enum(runSourceKindValues),
  adapter: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  nativeSessionId: z.string().min(1).optional(),
}).strict();
export type RunSource = z.infer<typeof runSourceSchema>;

/** Generic runtime-home identity; deployment-specific policy lives in the composing application. */
export const runtimeHomeDescriptorSchema = z.object({
  kind: idSchema,
  configuration: z.record(z.string(), jsonValueSchema),
}).strict();
export type RuntimeHomeDescriptor = z.infer<typeof runtimeHomeDescriptorSchema>;

export const scenarioExtensionSchema = z.object({
  schemaId: z.string().min(1),
  visibility: visibilitySchema,
  value: jsonValueSchema,
}).strict();
export type ScenarioExtension = z.infer<typeof scenarioExtensionSchema>;
