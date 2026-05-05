import type { CanonicalMcp } from "../../src/adapter/types.js";
import { CANONICAL_MCPS } from "../../src/adapter/types.js";

const RE = /^mcp__agent_framework__([a-z_]+)$/;
const SET: ReadonlySet<string> = new Set(CANONICAL_MCPS);

export function recognizeMcp(raw: string): CanonicalMcp | null {
  const m = raw.match(RE);
  return m && SET.has(m[1]) ? (m[1] as CanonicalMcp) : null;
}

export function mcpWireName(c: CanonicalMcp): string {
  return `mcp__agent_framework__${c}`;
}
