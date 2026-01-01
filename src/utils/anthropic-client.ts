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
 * - Commands are deterministic (linter, make check, git commands)
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
