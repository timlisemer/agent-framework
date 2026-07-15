import {
  canonicalMcpFromName,
  createMcpWireHelpers,
} from "../../src/adapter/mcp-wire.js";

const helpers = createMcpWireHelpers("mcp__agent_framework__");

export const { recognizeMcpServerTool, mcpWireName } = helpers;

export function recognizeMcp(raw: string) {
  const canonical = helpers.recognizeMcp(raw);
  if (canonical) return canonical;
  const legacy = /^mcp__agent_framework([a-z_]+)$/.exec(raw)?.[1];
  return legacy ? canonicalMcpFromName(legacy) : null;
}
