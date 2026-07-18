import type { ScenarioHello } from "./gateway.js";
import { scenarioProtocolSchemaDigest } from "./schema.js";

export type ScenarioNegotiationResult =
  | { ok: true; schemaDigest: string }
  | { ok: false; code: "incompatible_schema"; message: string };

/** Require the exact canonical schema. */
export function negotiateScenarioHello(
  hello: ScenarioHello,
  canonicalDigest = scenarioProtocolSchemaDigest(),
): ScenarioNegotiationResult {
  if (!hello.schemaDigests.includes(canonicalDigest)) {
    return {
      ok: false,
      code: "incompatible_schema",
      message: `Client does not support the canonical Scenario schema ${canonicalDigest}`,
    };
  }
  return { ok: true, schemaDigest: canonicalDigest };
}
