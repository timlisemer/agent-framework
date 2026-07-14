/**
 * Adapter dispatcher - resolves the active AdapterSpec from
 * AGENT_FRAMEWORK_ADAPTER env and the registered spec map.
 *
 * Adding a third adapter requires:
 *   1. Creating adapters/<name>/ with the 10 canonical files.
 *   2. Adding one import + one entry to SPECS below.
 *   Zero changes anywhere else in src/.
 *
 * @module adapter/spec
 */

import type { AdapterSpec, CanonicalMcp } from "./types.js";
import { CANONICAL_MCPS } from "./types.js";
import { claudeSpec } from "../../adapters/claude/index.js";
import { codexSpec }  from "../../adapters/codex/index.js";

const DEFAULT_ADAPTER = claudeSpec.name;

function specs(): Readonly<Record<string, AdapterSpec>> {
  return Object.freeze({
    [claudeSpec.name]: claudeSpec,
    [codexSpec.name]:  codexSpec,
  });
}

export function allAdapterSpecs(): readonly AdapterSpec[] {
  return Object.values(specs());
}

export function activeSpec(): AdapterSpec {
  const name = process.env.AGENT_FRAMEWORK_ADAPTER ?? DEFAULT_ADAPTER;
  const spec = specs()[name];
  if (!spec) throw new Error(`Unknown adapter: ${name}`);
  return spec;
}

export function adapterSpecByName(name: string): AdapterSpec {
  const spec = specs()[name];
  if (!spec) throw new Error(`Unknown adapter: ${name}`);
  return spec;
}

export function mcpWireNameForText(canonical: CanonicalMcp, text: string): string {
  for (const spec of Object.values(specs())) {
    for (const known of CANONICAL_MCPS) {
      if (text.includes(spec.mcpWireName(known))) return spec.mcpWireName(canonical);
    }
  }
  return activeSpec().mcpWireName(canonical);
}

/** Registered adapter names - used by validateScenario to validate env.adapter. */
export function registeredAdapterNames(): readonly string[] {
  return Object.keys(specs());
}
