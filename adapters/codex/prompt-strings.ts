import { mcpWireName } from "./recognize-mcp.js";
import { renderWorkflowInvocation } from "./workflow-invocation.js";
import type { CanonicalWorkflow } from "../../src/adapter/types.js";

export const instructionLabel = "AGENTS.md/CLAUDE.md";

export function renderMcpWaitRecommendation(timeoutMs: number): string {
  return `Recommended wait time: ${timeoutMs} ms; if this MCP call yields a cell ID, use \`wait({"cell_id":"<cell_id>","yield_time_ms":${timeoutMs}})\`.`;
}

export function renderCheckMcpHint(): string {
  return `agent-framework-check skill / agent-framework check MCP (${mcpWireName("check")})`;
}

export function renderWorkflowAuthorizationHint(canonicals: readonly CanonicalWorkflow[]): string {
  return canonicals.map(renderWorkflowInvocation).join(", ");
}
