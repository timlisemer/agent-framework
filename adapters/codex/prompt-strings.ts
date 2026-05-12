import { mcpWireName } from "./recognize-mcp.js";
import { renderWorkflowInvocation } from "./workflow-invocation.js";
import type { CanonicalWorkflow } from "../../src/adapter/types.js";

export const instructionLabel = "AGENTS.md/CLAUDE.md";

export function renderCheckMcpHint(): string {
  return `agent-framework-check skill / agent-framework check MCP (${mcpWireName("check")})`;
}

export function renderWorkflowAuthorizationHint(canonicals: readonly CanonicalWorkflow[]): string {
  return canonicals.map(renderWorkflowInvocation).join(", ");
}
