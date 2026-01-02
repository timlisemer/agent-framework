/**
 * Standard Transcript Configurations
 *
 * Different agents need different transcript views:
 * - Error acknowledgment: needs tool results to check for errors
 * - Appeal: needs recent messages for context on user intent
 * - Off-topic check: needs both with tool context
 * - Plan validation: needs user messages to check against request
 *
 * These presets use guaranteed counts - they will scan backwards until
 * the exact count of each message type is collected (or transcript exhausted).
 */

import type { TranscriptReadOptions } from "./transcript.js";

/**
 * For error acknowledgment checks.
 *
 * Includes tool results to detect errors in command output.
 * Trims tool output to focus on error-relevant lines.
 * Excludes Task/Agent outputs (too verbose, rarely contain errors).
 */
export const ERROR_CHECK_COUNTS: TranscriptReadOptions = {
  counts: { user: 3, assistant: 3, toolResult: 5 },
  toolResultOptions: {
    trim: true,
    maxLines: 20,
    excludeToolNames: ['Task', 'Agent', 'TaskOutput'],
  },
};

/**
 * For appeal decisions.
 *
 * Includes both user and assistant messages for context.
 * More messages to understand conversation flow.
 * No tool results - appeal focuses on user intent, not tool output.
 * Includes first user message to capture initial request context.
 */
export const APPEAL_COUNTS: TranscriptReadOptions = {
  counts: { user: 10, assistant: 10 },
  includeFirstUserMessage: true,
};

/**
 * For off-topic / intent validation.
 *
 * Full context with tool results to understand what AI has been doing.
 * Excludes Task/Agent outputs (sub-agent chatter is noise).
 */
export const OFF_TOPIC_COUNTS: TranscriptReadOptions = {
  counts: { user: 5, assistant: 5, toolResult: 5 },
  toolResultOptions: {
    trim: true,
    maxLines: 20,
    excludeToolNames: ['Task', 'Agent', 'TaskOutput'],
  },
};

/**
 * For plan drift validation.
 *
 * User messages with assistant context - checking if plan matches user's request.
 * Includes assistant messages to see user approvals and confirmations.
 * Always includes first user message to capture initial request.
 */
export const PLAN_VALIDATE_COUNTS: TranscriptReadOptions = {
  counts: { user: 20, assistant: 10 },
  includeFirstUserMessage: true,
};

/**
 * For quick context checks.
 *
 * Both user and assistant, but fewer messages.
 * Used when just need recent context without full history.
 */
export const QUICK_CONTEXT_COUNTS: TranscriptReadOptions = {
  counts: { user: 3, assistant: 3 },
};

/**
 * For style drift checks.
 *
 * Only user messages - checking if user requested style changes.
 * Fewer messages since style requests are usually recent.
 */
export const STYLE_DRIFT_COUNTS: TranscriptReadOptions = {
  counts: { user: 5 },
};

/**
 * For validate-intent checks.
 *
 * Comprehensive user+assistant context without tool results.
 * Focus is on request vs response alignment, not intermediate tool calls.
 */
export const VALIDATE_INTENT_COUNTS: TranscriptReadOptions = {
  counts: { user: 10, assistant: 5 },
};

/**
 * For first-response-intent checks.
 *
 * Gets last user message and any assistant text before the current tool call.
 * Includes first user message to capture original request context.
 * More assistant messages to catch acknowledgments in the current turn.
 */
export const FIRST_RESPONSE_INTENT_COUNTS: TranscriptReadOptions = {
  counts: { user: 3, assistant: 5 },
  includeFirstUserMessage: true,
};

/**
 * For first-response-intent stop checks.
 *
 * Gets last user message and last assistant response to check for
 * plain text questions, unanswered user questions, and tool usage violations.
 */
export const FIRST_RESPONSE_STOP_COUNTS: TranscriptReadOptions = {
  counts: { user: 3, assistant: 3 },
};

/**
 * For checking recent tool approvals (e.g., ExitPlanMode).
 *
 * Only tool results needed - checking if a specific tool was recently approved.
 * Used to skip redundant validations when user already approved an action.
 */
export const RECENT_TOOL_APPROVAL_COUNTS: TranscriptReadOptions = {
  counts: { toolResult: 10 },
};
