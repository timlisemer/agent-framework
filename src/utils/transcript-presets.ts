/**
 * Standard Transcript Configurations
 *
 * Different agents need different transcript views:
 * - Appeal: needs recent messages for context on user intent
 * - Plan validation: needs user messages to check against request
 * - Style drift: needs user messages to check for style requests
 *
 * These presets use guaranteed counts - they will scan backwards until
 * the exact count of each message type is collected (or transcript exhausted).
 */

import { validateTranscriptConfig } from "./transcript.js";
import { FIRST_RESPONSE_STOP_COUNTS } from "./transcript-preset-values.js";
export {
  APPEAL_COUNTS,
  FIRST_RESPONSE_STOP_COUNTS,
  PLAN_VALIDATE_COUNTS,
  QUESTION_VALIDATE_COUNTS,
  VALIDATE_INTENT_COUNTS,
} from "./transcript-preset-values.js";

/**
 * For appeal decisions.
 *
 * Includes both user and assistant messages for context.
 * More messages to understand conversation flow.
 * Includes first user message to capture initial request context.
 * Plan approval and todo state are always synthesized into transcript.
 */

/**
 * For plan drift validation.
 *
 * User messages with assistant context - checking if plan matches user's request.
 * Includes assistant messages to see user approvals and confirmations.
 * Always includes first user message to capture initial request.
 */

/**
 * For validate-intent checks.
 *
 * Comprehensive user+assistant context without tool results.
 * Focus is on request vs response alignment, not intermediate tool calls.
 */

/**
 * For first-response-intent stop checks.
 *
 * Gets last user message and last assistant response to check for
 * plain text questions, unanswered user questions, and tool usage violations.
 *
 * User message has maxStale to prevent false positives on old questions
 * that were already addressed through planning/implementation cycles.
 * tool is included so the hook can see if work was done between
 * the user message and now.
 */

/**
 * For question validation (AskUserQuestion tool).
 *
 * ALL user messages - to find if user already answered the question.
 * Recent assistant messages - to check if referenced content was shown.
 * Recent tool results - to see what Claude has done (Write to plan, etc.).
 */

// =============================================================================
// COMPILE-TIME VALIDATION
// =============================================================================
// Validate all presets with maxStale at module load time.
// This ensures misconfigured presets are caught early, not at runtime.

validateTranscriptConfig(FIRST_RESPONSE_STOP_COUNTS, "FIRST_RESPONSE_STOP_COUNTS");
