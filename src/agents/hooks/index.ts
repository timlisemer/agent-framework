/**
 * Hook-Triggered Agents
 *
 * These agents are triggered by adapter hooks (PreToolUse, Stop).
 * They use the direct Anthropic API for fast validation.
 *
 * ## WHY DIRECT API (not SDK streaming)?
 *
 * Hook agents are validators that run INSIDE the host agent's tool execution loop.
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
 * ## HOOK AGENTS
 *
 * PreToolUse Hook (`src/hooks/pre-tool-use.ts`):
 * - tool-appeal: Reviews denials with user context (haiku)
 * - plan-validate: Checks plan drift against user request (sonnet)
 */

export { appealHelper } from './tool-appeal.js';
export { checkPlanIntent } from './plan-validate.js';
