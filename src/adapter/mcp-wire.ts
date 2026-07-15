import type { CanonicalMcp } from "./types.js";
import { CANONICAL_MCPS } from "./types.js";

const CANONICAL_MCP_SET: ReadonlySet<string> = new Set(CANONICAL_MCPS);

export interface McpWireHelpers {
  recognizeMcp(raw: string): CanonicalMcp | null;
  recognizeMcpServerTool(server: string, tool: string): CanonicalMcp | null;
  mcpWireName(canonical: CanonicalMcp): string;
}

type McpRecognizer = Pick<McpWireHelpers, "recognizeMcp">;

/** Validate a bare canonical MCP capability name. */
export function canonicalMcpFromName(name: string): CanonicalMcp | null {
  return CANONICAL_MCP_SET.has(name) ? name as CanonicalMcp : null;
}

/** Recognize a validated internal `mcp-*` canonical tool name. */
export function recognizeCanonicalMcpToolName(toolName: string): CanonicalMcp | null {
  return toolName.startsWith("mcp-")
    ? canonicalMcpFromName(toolName.slice("mcp-".length))
    : null;
}

/** Recognize either an internal canonical name or the active adapter's wire name. */
export function recognizeMcpToolName(
  toolName: string,
  recognizer: McpRecognizer,
): CanonicalMcp | null {
  return recognizeCanonicalMcpToolName(toolName) ?? recognizer.recognizeMcp(toolName);
}

export function createMcpWireHelpers(wirePrefix: string): McpWireHelpers {
  const escapedPrefix = wirePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escapedPrefix}([a-z_]+)$`);
  const adapterServer = wirePrefix.replace(/^mcp__/, "").replace(/__$/, "");
  return {
    recognizeMcp(raw) {
      const match = raw.match(re);
      return match ? canonicalMcpFromName(match[1]) : null;
    },
    recognizeMcpServerTool(server, tool) {
      if (normalizeMcpServerName(server) !== normalizeMcpServerName(adapterServer)) return null;
      return canonicalMcpFromName(tool);
    },
    mcpWireName(canonical) {
      return `${wirePrefix}${canonical}`;
    },
  };
}

function normalizeMcpServerName(value: string): string {
  return value.replace(/[-_]/g, "").toLowerCase();
}
