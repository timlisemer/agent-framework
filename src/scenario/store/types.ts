import { z } from "zod";
import { runCapabilitiesSchema } from "../protocol/capabilities.js";
import {
  idSchema,
  jsonValueSchema,
  runSourceSchema,
  runtimeHomeDescriptorSchema,
  scenarioStoragePolicySchema,
  timestampSchema,
} from "../protocol/common.js";
import { scenarioRunStatusSchema } from "../protocol/snapshot.js";

export const runManifestSchema = z.object({
  runId: idSchema,
  source: runSourceSchema,
  workingDir: z.string().nullable(),
  projectDir: z.string().nullable(),
  adapter: z.string().nullable(),
  provider: z.string().nullable(),
  nativeSessionIds: z.array(z.string()),
  engineVersion: z.string().min(1),
  schemaDigest: z.string().min(1),
  capabilities: runCapabilitiesSchema,
  storagePolicy: scenarioStoragePolicySchema,
  runtimeHome: runtimeHomeDescriptorSchema,
  configuration: z.record(z.string(), jsonValueSchema),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  status: scenarioRunStatusSchema,
}).strict();
export type RunManifest = z.infer<typeof runManifestSchema>;

export const runRegistryEntrySchema = z.object({
  runId: idSchema,
  operation: z.enum(["created", "updated", "closed"]),
  status: runManifestSchema.shape.status,
  source: runSourceSchema,
  workingDir: z.string().nullable(),
  updatedAt: timestampSchema,
}).strict();
export type RunRegistryEntry = z.infer<typeof runRegistryEntrySchema>;
