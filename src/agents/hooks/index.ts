/**
 * Hook-Triggered Agents
 *
 * These agents are triggered by Claude Code hooks (PreToolUse, Stop).
 * They use the direct Anthropic API for fast validation.
 *
 * ## WHY DIRECT API (not SDK streaming)?
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
 * ## HOOK AGENTS
 *
 * PreToolUse Hook (`src/hooks/pre-tool-use.ts`):
 * - tool-approve: Policy enforcement (haiku)
 * - tool-appeal: Reviews denials with user context (haiku)
 * - error-acknowledge: Ensures AI acknowledges issues (haiku)
 * - plan-validate: Checks plan drift against user request (sonnet)
 * - style-drift: Detects unrequested style changes (haiku)
 *
 * Stop Hook (`src/hooks/stop-off-topic-check.ts`):
 * - intent-validate: Detects off-topic AI behavior (haiku)
 */

export { approveTool } from './tool-approve.js';
export { appealDenial } from './tool-appeal.js';
export { checkErrorAcknowledgment } from './error-acknowledge.js';
export { validatePlanIntent } from './plan-validate.js';
export { checkForOffTopic, extractConversationContext } from './intent-validate.js';
export { checkStyleDrift } from './style-drift.js';
