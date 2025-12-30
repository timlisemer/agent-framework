import { getModelId } from '../../types.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { extractTextFromResponse } from '../../utils/response-parser.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

export async function appealDenial(
  toolName: string,
  toolInput: unknown,
  transcript: string,
  originalReason: string
): Promise<{ approved: boolean; reason?: string }> {
  const anthropic = getAnthropicClient();
  const toolDescription = `${toolName} with ${JSON.stringify(toolInput)}`;

  const response = await anthropic.messages.create({
    model: getModelId('haiku'),
    max_tokens: 500,
    messages: [
      {
        role: 'user',
        content: `You are reviewing an appeal. The tool call was initially blocked for a technical reason.

BLOCK REASON: ${originalReason}
TOOL CALL: ${toolDescription}

RECENT CONVERSATION:
${transcript}

The original block is ALWAYS technically correct. Your ONLY job is to check if the user explicitly approved this tool call or if there's a mismatch.

OVERTURN TO APPROVE when:
- User explicitly requested this exact tool operation
- User invoked a slash command requiring this operation (/push, /commit)
- User explicitly confirmed when asked
→ The user knowingly wants this despite the technical restriction

OVERTURN WITH NEW REASON when:
- User asked for X but AI is autonomously doing Y (clear mismatch)
  Example: User said "check the code" but AI is writing/editing files
  Reply: OVERTURN: User asked to check, not modify
- User explicitly opposed this operation (said no/don't/stop)
  Reply: OVERTURN: User explicitly opposed

UPHOLD (default) when:
- User's request was vague or general
- No explicit user approval for this exact operation
- Anything unclear
→ The original technical reason stands

CRITICAL: You are NOT judging if the technical rule is correct (it always is).
You are ONLY checking if the user explicitly approved this specific tool operation.

===== OUTPUT FORMAT (STRICT) =====
Your response MUST start with EXACTLY one of these three formats. DO NOT add any explanation before the decision:

UPHOLD
OR
OVERTURN: APPROVE
OR
OVERTURN: <new reason>

NO other text before the decision word. NO explanations first. NO preamble.

Examples:
- User: "check the code", Tool: Read → UPHOLD
- User: "please read /etc/passwd", Tool: Read /etc/passwd → OVERTURN: APPROVE
- User: "just check it", Tool: Edit (modifying file) → OVERTURN: User asked to check, not modify
- User: "don't do that" → OVERTURN: User explicitly opposed`,
      },
    ],
  });

  const decision = await retryUntilValid(
    anthropic,
    getModelId('haiku'),
    extractTextFromResponse(response),
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
    await logToHomeAssistant({
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

  await logToHomeAssistant({
    agent: 'tool-appeal',
    level: 'decision',
    problem: toolDescription,
    answer: reason ? `BLOCKED: ${reason}` : 'UPHELD (using original reason)',
  });

  return { approved: false, reason };
}
