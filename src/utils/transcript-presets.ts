/**
 * Standard Transcript Configurations
 *
 * Different agents need different transcript views:
 * - Error acknowledgment: needs tool results to check for errors
 * - Appeal: needs recent messages for context on user intent
 * - Off-topic check: needs both with tool context
 * - Plan validation: needs user messages to check against request
 *
 * These presets standardize configurations across agents.
 */

import {
  TranscriptFilter,
  MessageLimit,
  type TranscriptOptions,
} from './transcript.js';

/**
 * For error acknowledgment checks.
 *
 * Includes tool results to detect errors in command output.
 * Trims tool output to focus on error-relevant lines.
 * Excludes Task/Agent outputs (too verbose, rarely contain errors).
 */
export const ERROR_CHECK_PRESET: TranscriptOptions = {
  filter: TranscriptFilter.BOTH_WITH_TOOLS,
  limit: MessageLimit.FIVE,
  trimToolOutput: true,
  maxToolOutputLines: 20,
  excludeToolNames: ['Task', 'Agent', 'TaskOutput'],
};

/**
 * For appeal decisions.
 *
 * Includes both user and assistant messages for context.
 * More messages (10) to understand conversation flow.
 * No tool results - appeal focuses on user intent, not tool output.
 */
export const APPEAL_PRESET: TranscriptOptions = {
  filter: TranscriptFilter.BOTH,
  limit: MessageLimit.TEN,
};

/**
 * For off-topic / intent validation.
 *
 * Full context with tool results to understand what AI has been doing.
 * Excludes Task/Agent outputs (sub-agent chatter is noise).
 */
export const OFF_TOPIC_PRESET: TranscriptOptions = {
  filter: TranscriptFilter.BOTH_WITH_TOOLS,
  limit: MessageLimit.TEN,
  trimToolOutput: true,
  maxToolOutputLines: 20,
  excludeToolNames: ['Task', 'Agent', 'TaskOutput'],
};

/**
 * For plan drift validation.
 *
 * Only user messages - checking if plan matches user's request.
 * More messages (10) to capture full context of what user asked for.
 */
export const PLAN_VALIDATE_PRESET: TranscriptOptions = {
  filter: TranscriptFilter.USER_ONLY,
  limit: MessageLimit.TEN,
};

/**
 * For quick context checks.
 *
 * Both user and assistant, but fewer messages.
 * Used when just need recent context without full history.
 */
export const QUICK_CONTEXT_PRESET: TranscriptOptions = {
  filter: TranscriptFilter.BOTH,
  limit: MessageLimit.FIVE,
};
