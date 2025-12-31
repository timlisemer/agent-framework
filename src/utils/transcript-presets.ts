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
 */
export const APPEAL_COUNTS: TranscriptReadOptions = {
  counts: { user: 5, assistant: 5 },
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
 * Only user messages - checking if plan matches user's request.
 * Guarantees exactly 10 user messages (or all available).
 */
export const PLAN_VALIDATE_COUNTS: TranscriptReadOptions = {
  counts: { user: 10 },
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
