/**
 * OpenRouter Cost Fetching
 *
 * OpenRouter doesn't return cost in the immediate API response.
 * Cost must be fetched asynchronously from their generation endpoint.
 *
 * Endpoint: GET https://openrouter.ai/api/v1/generation?id={generationId}
 *
 * The generation data takes ~2 seconds to be indexed after the request completes.
 */

import "./load-env.js";

/**
 * Generation data returned by OpenRouter's generation endpoint.
 */
export interface OpenRouterGenerationData {
  id: string;
  model: string;
  total_cost: number;
  native_tokens_prompt: number;
  native_tokens_completion: number;
  native_tokens_reasoning: number;
  native_tokens_cached: number;
  cache_discount: number | null;
  latency: number;
  created_at: string;
}

/**
 * Check if we're using OpenRouter (based on env config).
 */
export function isOpenRouterEnabled(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || "";
  return baseUrl.includes("openrouter.ai");
}

/**
 * Fetch generation data including cost from OpenRouter.
 *
 * @param generationId - The generation ID from the API response (e.g., "gen-xxx")
 * @param delayMs - Delay before fetching (OpenRouter needs time to index)
 * @returns Generation data with cost, or null if fetch fails
 */
export async function fetchOpenRouterCost(
  generationId: string,
  delayMs = 2000
): Promise<OpenRouterGenerationData | null> {
  if (!isOpenRouterEnabled()) {
    return null;
  }

  // Wait for OpenRouter to index the generation
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  const authToken = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  if (!authToken) {
    return null;
  }

  try {
    const response = await fetch(
      `https://openrouter.ai/api/v1/generation?id=${generationId}`,
      {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      }
    );

    if (!response.ok) {
      return null;
    }

    const json = await response.json();
    return json.data as OpenRouterGenerationData;
  } catch {
    return null;
  }
}

/**
 * Fire-and-forget cost fetch that updates usage data via callback.
 *
 * Use this when you don't want to block on cost fetching.
 * The callback is called with the generation data once available.
 *
 * @param generationId - The generation ID from the API response
 * @param onCostFetched - Callback with generation data (called after delay)
 */
export function fetchOpenRouterCostAsync(
  generationId: string,
  onCostFetched: (data: OpenRouterGenerationData) => void
): void {
  if (!isOpenRouterEnabled()) {
    return;
  }

  // Fire-and-forget
  fetchOpenRouterCost(generationId).then((data) => {
    if (data) {
      onCostFetched(data);
    }
  }).catch(() => {
    // Silently ignore errors for fire-and-forget
  });
}
