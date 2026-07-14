import { activeSpec } from "../adapter/spec.js";
import type { AdapterSpec } from "../adapter/types.js";
import { mcpTimeoutForTool } from "../mcp/timeout.js";

type McpWaitAdapter = Pick<AdapterSpec, "renderMcpWaitRecommendation">;

export function appendMcpWaitRecommendation(
  toolName: string,
  description: string | undefined,
  adapter: McpWaitAdapter = activeSpec(),
): string {
  const recommendation = adapter.renderMcpWaitRecommendation(
    mcpTimeoutForTool(toolName),
  );
  return description ? `${description}\n\n${recommendation}` : recommendation;
}
