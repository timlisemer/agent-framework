import { createMcpWireHelpers } from "../../src/adapter/mcp-wire.js";

const helpers = createMcpWireHelpers("mcp__agent_framework__");

export const { recognizeMcpServerTool, mcpWireName } = helpers;

export function recognizeMcp(raw: string) {
  return helpers.recognizeMcp(raw);
}
