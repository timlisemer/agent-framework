/**
 * Anthropic Client Factory
 *
 * This module provides a singleton Anthropic client for hook agents.
 *
 * ## WHY A SINGLETON?
 *
 * The Anthropic SDK maintains internal state (connection pooling, rate limiting).
 * Creating multiple clients wastes resources and can cause rate limit issues.
 *
 * ## WHY HOOK AGENTS USE DIRECT API (not SDK streaming)
 *
 * Hook agents are validators that run INSIDE Claude's tool execution loop.
 * They must be:
 * - Fast (<100ms) - validation should not noticeably delay tool execution
 * - Lightweight - no sub-agent spawning or tool orchestration needed
 * - Synchronous in nature - single request/response, no streaming required
 *
 * The direct Anthropic API (`messages.create`) is perfect for this:
 * - Lower overhead than the Agent SDK
 * - No streaming complexity
 * - Simple request/response pattern
 *
 * ## WHY MCP AGENTS USE SDK STREAMING (runAgentQuery)
 *
 * MCP agents (check, confirm, commit) need:
 * - Shell access via Bash tool - the Agent SDK provides tool orchestration
 * - Streaming output - captures incremental results from long-running commands
 * - Multi-turn execution - agent can run multiple commands in sequence
 *
 * The Agent SDK wrapper in `agent-query.ts` handles all this complexity.
 *
 * ## USAGE
 *
 * Hook agents (tool-approve, tool-appeal, error-acknowledge, etc.):
 * ```typescript
 * import { getAnthropicClient } from '../utils/anthropic-client.js';
 *
 * const client = getAnthropicClient();
 * const response = await client.messages.create({ ... });
 * ```
 *
 * MCP agents (check, confirm, commit):
 * ```typescript
 * import { runAgentQuery } from '../utils/agent-query.js';
 *
 * const result = await runAgentQuery('agent-name', prompt, options);
 * ```
 */

import Anthropic from '@anthropic-ai/sdk';

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
