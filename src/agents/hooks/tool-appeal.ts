/**
 * Tool Appeal Agent - Review Denied Tool Calls
 *
 * This agent reviews tool calls that were initially denied to check if
 * the user explicitly approved the operation or if there's a mismatch.
 *
 * ## FLOW
 *
 * 1. Receive denial reason and transcript context
 * 2. Run unified agent to evaluate appeal
 * 3. Retry if format is invalid
 * 4. Return UPHOLD, OVERTURN to approve, or OVERTURN with new reason
 *
 * ## CRITICAL
 *
 * The original denial is ALWAYS technically correct. This agent only checks:
 * - Did user explicitly request this operation?
 * - Is there a clear mismatch between user request and AI action?
 *
 * @module tool-appeal
 */

import { getModelId } from '../../types.js';
import { runAgent } from '../../utils/agent-runner.js';
import { TOOL_APPEAL_AGENT } from '../../utils/agent-configs.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

/**
 * Review an appeal for a denied tool call.
 *
 * @param toolName - Name of the denied tool
 * @param toolInput - Input parameters for the tool
 * @param transcript - Recent conversation context
 * @param originalReason - The original denial reason
 * @returns Approval result with optional new reason
 *
 * @example
 * ```typescript
 * const result = await appealDenial(
 *   'Bash',
 *   { command: 'curl ...' },
 *   transcript,
 *   'Network requests denied by default'
 * );
 * if (result.approved) {
 *   // User explicitly approved this operation
 * }
 * ```
 */
export async function appealDenial(
  toolName: string,
  toolInput: unknown,
  transcript: string,
  originalReason: string
): Promise<{ approved: boolean; reason?: string }> {
  const toolDescription = `${toolName} with ${JSON.stringify(toolInput)}`;

  // Run appeal evaluation via unified runner
  const initialResponse = await runAgent(
    { ...TOOL_APPEAL_AGENT },
    {
      prompt: 'Review this appeal for a denied tool call.',
      context: `BLOCK REASON: ${originalReason}
TOOL CALL: ${toolDescription}

RECENT CONVERSATION:
${transcript}`,
    }
  );

  // Retry if format is invalid
  const anthropic = getAnthropicClient();
  const decision = await retryUntilValid(
    anthropic,
    getModelId('haiku'),
    initialResponse,
    toolDescription,
    {
      maxRetries: 2,
      formatValidator: (text) =>
        startsWithAny(text, ['UPHOLD', 'OVERTURN:', 'DENY:', 'DENY']),
      formatReminder:
        'Reply with EXACTLY: UPHOLD, OVERTURN: APPROVE, or OVERTURN: <reason>',
    }
  );

  // Check for approval (overturn)
  if (decision.startsWith('OVERTURN: APPROVE') || decision === 'APPROVE') {
    logToHomeAssistant({
      agent: 'tool-appeal',
      level: 'decision',
      problem: toolDescription,
      answer: 'OVERTURNED → APPROVED',
    });
    return { approved: true };
  }

  // Parse block/uphold - extract reason if provided
  let reason: string | undefined;
  const normalizedDecision = decision.trim().toUpperCase();

  // CODE-LEVEL SAFEGUARD: If response contains UPHOLD in any form, ALWAYS return undefined
  // This ensures the original tool-approve reason is used, regardless of LLM output
  if (normalizedDecision.includes('UPHOLD')) {
    reason = undefined;
  } else if (decision.startsWith('OVERTURN: ')) {
    // Overturn with new reason - ONLY case where appeal provides a reason
    reason = decision.replace('OVERTURN: ', '');
    if (reason === 'APPROVE') reason = undefined; // Already handled above, but safety
  } else if (decision.startsWith('DENY: ')) {
    // Old format compatibility - appeal provides reason
    reason = decision.replace('DENY: ', '');
  } else if (normalizedDecision === 'DENY') {
    // Bare DENY - defer to original
    reason = undefined;
  } else {
    // Truly malformed - treat as uphold to be safe (defer to original)
    reason = undefined;
  }

  logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: toolDescription,
    answer: reason ? `BLOCKED: ${reason}` : 'UPHELD (using original reason)',
  });

  return { approved: false, reason };
}
