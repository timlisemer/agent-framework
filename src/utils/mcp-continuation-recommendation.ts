import { activeSpec } from "../adapter/spec.js";
import type { AdapterSpec } from "../adapter/types.js";
import { mcpTimeoutForTool } from "../mcp/timeout.js";

type McpContinuationAdapter = Pick<AdapterSpec, "renderMcpContinuationRecommendation">;

export function appendMcpContinuationRecommendation(
  toolName: string,
  description: string | undefined,
  adapter: McpContinuationAdapter = activeSpec(),
): string {
  const recommendation = adapter.renderMcpContinuationRecommendation(
    mcpTimeoutForTool(toolName),
  );
  return description ? `${description}\n\n${recommendation}` : recommendation;
}
