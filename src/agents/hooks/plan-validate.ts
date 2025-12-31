/**
 * Plan Validate Agent - Plan-Intent Alignment Checker
 *
 * This agent detects when an AI's plan has drifted from the user's original
 * request. It catches contradictions, unrelated scope, and over-engineering.
 *
 * ## FLOW
 *
 * 1. Skip if no user messages or empty plan
 * 2. Run unified agent to check alignment
 * 3. Retry if format is invalid
 * 4. Return OK or DRIFT with feedback
 *
 * ## DRIFT DETECTION
 *
 * Detects:
 * - Plan contradicts user instructions
 * - Plan does something fundamentally different
 * - Plan adds major unrelated scope
 * - Plan includes test sections, time estimates, or manual build commands
 *
 * Allows:
 * - Incomplete but on-track plans
 * - Reasonable interpretation of ambiguous requests
 * - Plans mentioning check MCP tool for verification
 *
 * @module plan-validate
 */

import { getModelId } from '../../types.js';
import { runAgent } from '../../utils/agent-runner.js';
import { PLAN_VALIDATE_AGENT } from '../../utils/agent-configs.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

/**
 * Validate that a plan aligns with user intent.
 *
 * @param planContent - The plan content being written
 * @param userMessages - User messages from the conversation
 * @returns Approval result with optional drift feedback
 *
 * @example
 * ```typescript
 * const result = await validatePlanIntent(planContent, userMessages);
 * if (!result.approved) {
 *   console.log('Plan drift:', result.reason);
 * }
 * ```
 */
export async function validatePlanIntent(
  planContent: string,
  userMessages: string
): Promise<{ approved: boolean; reason?: string }> {
  // No user messages yet - nothing to validate against
  if (!userMessages.trim()) {
    return { approved: true };
  }

  // Empty plan content - allow (might be initial file creation)
  if (!planContent.trim()) {
    return { approved: true };
  }

  try {
    // Run plan validation via unified runner
    const initialResponse = await runAgent(
      { ...PLAN_VALIDATE_AGENT },
      {
        prompt: 'Check if this plan aligns with the user request.',
        context: `USER MESSAGES:
${userMessages}

---

PLAN CONTENT:
${planContent}

---

Does this plan align with the user's request, or has it drifted?`,
      }
    );

    // Retry if format is invalid
    const anthropic = getAnthropicClient();
    const decision = await retryUntilValid(
      anthropic,
      getModelId('sonnet'), // Standardized on Sonnet for both initial and retry
      initialResponse,
      `Plan validation for: ${planContent.substring(0, 100)}...`,
      {
        maxRetries: 2,
        formatValidator: (text) => startsWithAny(text, ['OK', 'DRIFT:']),
        formatReminder: 'Reply with exactly: OK or DRIFT: <feedback>',
        maxTokens: 150,
      }
    );

    if (decision.startsWith('DRIFT:')) {
      const feedback = decision.replace('DRIFT:', '').trim();

      logToHomeAssistant({
        agent: 'plan-validate',
        level: 'decision',
        problem: `Plan write: ${planContent.substring(0, 100)}...`,
        answer: `DRIFT: ${feedback}`,
      });

      return {
        approved: false,
        reason: feedback,
      };
    }

    logToHomeAssistant({
      agent: 'plan-validate',
      level: 'decision',
      problem: `Plan write: ${planContent.substring(0, 100)}...`,
      answer: 'OK',
    });

    return { approved: true };
  } catch (err) {
    // On issue, fail open (allow the write)
    logToHomeAssistant({
      agent: 'plan-validate',
      level: 'info',
      problem: 'Validation issue',
      answer: String(err),
    });

    return { approved: true };
  }
}
