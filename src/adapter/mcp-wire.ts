import type { CanonicalMcp } from "./types.js";
import { CANONICAL_MCPS } from "./types.js";

const CANONICAL_MCP_SET: ReadonlySet<string> = new Set(CANONICAL_MCPS);

export interface McpWireHelpers {
  recognizeMcp(raw: string): CanonicalMcp | null;
  recognizeMcpServerTool(server: string, tool: string): CanonicalMcp | null;
  mcpWireName(canonical: CanonicalMcp): string;
}

export function createMcpWireHelpers(wirePrefix: string): McpWireHelpers {
  const escapedPrefix = wirePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedPrefix}([a-z_]+)$`);
  const adapterServer = wirePrefix.replace(/^mcp__/, "").replace(/__$/, "");
  return {
    recognizeMcp(raw) {
      const match = raw.match(re);
      return match && CANONICAL_MCP_SET.has(match[1]) ? (match[1] as CanonicalMcp) : null;
    },
    recognizeMcpServerTool(server, tool) {
      if (normalizeMcpServerName(server) !== normalizeMcpServerName(adapterServer)) return null;
      return CANONICAL_MCP_SET.has(tool) ? (tool as CanonicalMcp) : null;
    },
    mcpWireName(canonical) {
      return `${wirePrefix}${canonical}`;
    },
  };
}

function normalizeMcpServerName(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}
