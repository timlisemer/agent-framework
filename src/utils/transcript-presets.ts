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

import type { TranscriptReadOptions } from './transcript.js';

/** Use Infinity to collect all messages of a type (scanner will exhaust transcript) */
const ALL = Infinity;

/**
 * For error acknowledgment checks.
 *
 * Includes tool results to detect errors in command output.
 * Trims tool output to focus on error-relevant lines.
 * Includes Task/Agent outputs so error-ack can see directive compliance.
 *
 * User message has maxStale: 1 to prevent stale directive re-checking.
 * Since error-ack runs on EVERY tool call, a user directive from 2+ entries
 * back has already been checked. Without maxStale, the same directive would
 * keep appearing with changing context, causing false "AI ignored directive" blocks.
 */
export const ERROR_CHECK_COUNTS: TranscriptReadOptions = {
  counts: { user: { count: 1, maxStale: 1 }, assistant: 1, toolResult: 2 },
  toolResultOptions: {
    trim: true,
    maxLines: 20,
    // NOTE: Do NOT exclude Task/Agent - error-ack needs to see that agents were run
    // Otherwise it incorrectly thinks directives weren't followed
  },
};

/**
 * For appeal decisions.
 *
 * Includes both user and assistant messages for context.
 * More messages to understand conversation flow.
 * Includes first user message to capture initial request context.
 * Plan approval and todo state are always synthesized into transcript.
 */
export const APPEAL_COUNTS: TranscriptReadOptions = {
  counts: { user: ALL, assistant: 10, toolResult: 3 },
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
  counts: { user: ALL, assistant: 10, toolResult: 10 },
  includeFirstUserMessage: true,
  toolResultOptions: {
    trim: false,
  },
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
  counts: { user: ALL, assistant: 5 },
  includeFirstUserMessage: true,
};

/**
 * For intent alignment checks.
 *
 * Gets all user messages to preserve AskUserQuestion responses and plan acceptances.
 * Includes first user message to capture original request context.
 * More assistant messages to catch acknowledgments in the current turn.
 */
export const INTENT_ALIGNMENT_COUNTS: TranscriptReadOptions = {
  counts: { user: ALL, assistant: 5, toolResult: 5 },
  includeFirstUserMessage: true,
  toolResultOptions: {
    trim: true,
    maxLines: 100,
    // NOTE: Do NOT exclude Task/Agent - response-align needs to see that agents were run
    // Otherwise it incorrectly thinks AI skipped requested agent actions
  },
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

/**
 * For question validation (AskUserQuestion tool).
 *
 * ALL user messages - to find if user already answered the question.
 * Recent assistant messages - to check if referenced content was shown.
 * Recent tool results - to see what Claude has done (Write to plan, etc.).
 */
export const QUESTION_VALIDATE_COUNTS: TranscriptReadOptions = {
  counts: { user: ALL, assistant: 5, toolResult: 10 },
  includeFirstUserMessage: true,
  toolResultOptions: {
    trim: true,
    maxLines: 30,
    excludeToolNames: ["Task", "Agent", "TaskOutput"],
  },
};
