/**
 * OpenRouter Utilities
 *
 * Helper functions for OpenRouter integration.
 * Cost fetching has been moved to the telemetry server.
 */

import "./load-env.js";

/**
 * Check if we're using OpenRouter (based on env config).
 */
export function isOpenRouterEnabled(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  return baseUrl.includes("openrouter.ai");
}
