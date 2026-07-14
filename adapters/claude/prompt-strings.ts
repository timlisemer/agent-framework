import { mcpWireName } from "./recognize-mcp.js";
import { renderWorkflowInvocation } from "./workflow-invocation.js";
import type { CanonicalWorkflow } from "../../src/adapter/types.js";

export const instructionLabel = "CLAUDE.md";

export function renderMcpWaitRecommendation(timeoutMs: number): string {
  return `Recommended wait time: ${timeoutMs} ms; wait on this MCP call directly until it completes or fails because Claude's \`TaskOutput\` command applies only to background tasks, not MCP calls.`;
}

export function renderCheckMcpHint(): string {
  return `agent-framework check MCP (${mcpWireName("check")})`;
}

export function renderWorkflowAuthorizationHint(canonicals: readonly CanonicalWorkflow[]): string {
  return canonicals.map(renderWorkflowInvocation).join(", ");
}
