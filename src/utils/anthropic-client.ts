/**
 * Anthropic Client Factory
 *
 * This module provides a singleton Anthropic client for all agents.
 *
 * ## WHY A SINGLETON?
 *
 * The Anthropic SDK maintains internal state (connection pooling, rate limiting).
 * Creating multiple clients wastes resources and can cause rate limit issues.
 *
 * ## WHY ALL AGENTS USE DIRECT API
 *
 * All agents use the direct Anthropic API (`messages.create`) because:
 *
 * **Hook agents** (tool-approve, tool-appeal, error-acknowledge, etc.):
 * - Run inside Claude's tool execution loop
 * - Must be fast (<100ms) - validation should not delay tool execution
 * - Simple request/response pattern
 *
 * **MCP agents** (check, confirm, commit):
 * - Commands are deterministic (linter, make/just check, git commands)
 * - No agent decision-making needed for tool selection
 * - Shell commands executed via execSync, then single API call to analyze
 * - Single request is cheaper than multi-turn SDK conversations
 * - Prevents "overthinking" or unwanted tool calls
 *
 * ## USAGE
 *
 * All agents:
 * ```typescript
 * import { getAnthropicClient } from '../utils/anthropic-client.js';
 *
 * const client = getAnthropicClient();
 * const response = await client.messages.create({ ... });
 * ```
 */

import "./load-env.js";
import Anthropic from "@anthropic-ai/sdk";
import AgentKeepAlive from "agentkeepalive";

// Custom HTTP agent to prevent connection-level hangs.
//
// The SDK's default agent (agentkeepalive with keepAlive: true, timeout: 5min)
// keeps connections pooled for up to 5 minutes with no idle socket cleanup and
// no active socket TTL. This allows stale/dead connections to persist and be
// reused for new requests that hang indefinitely.
//
// Root causes addressed:
// - Stale pooled connections: dead connections appear open, requests sent into void
// - OpenRouter proxy hangs (Cline #1407, #5829): proxy drops idle connections
//   silently, but the pooled socket still looks alive to the client
// - No connection rotation: long-lived sockets accumulate protocol-level issues
const httpsAgent = new AgentKeepAlive.HttpsAgent({
  keepAlive: true,
  // Close idle sockets after 30s — prevents reusing connections that OpenRouter
  // or intermediary proxies may have already closed on their end
  freeSocketTimeout: 30_000,
  // Max socket lifetime regardless of activity — forces periodic fresh connections
  // to prevent protocol-level issue accumulation on long-lived connections
  socketActiveTTL: 120_000,
});

let clientInstance: Anthropic | null = null;

/**
 * Get the singleton Anthropic client instance.
 *
 * Creates the client on first call, returns cached instance thereafter.
 * Uses environment variables for configuration:
 * - ANTHROPIC_API_KEY (required)
 * - ANTHROPIC_AUTH_TOKEN (optional)
 * - ANTHROPIC_BASE_URL (optional)
 */
export function getAnthropicClient(): Anthropic {
  if (!clientInstance) {
    clientInstance = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY || null,
      authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
      // Reduce from default 2 — framework's own retry loops (tool-approve,
      // tool-appeal) already handle retries with exponential backoff.
      // SDK retrying on the same broken connection compounds hangs.
      maxRetries: 1,
      httpAgent: httpsAgent,
      defaultHeaders: {
        "X-Title": "timlisemer/agent-framework",
        "HTTP-Referer": "https://github.com/timlisemer/agent-framework",
      },
    });
  }
  return clientInstance;
}

/**
 * Reset the client instance (useful for testing).
 * @internal
 */
export function resetAnthropicClient(): void {
  clientInstance = null;
}
