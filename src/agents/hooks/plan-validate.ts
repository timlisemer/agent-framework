import { getModelId } from '../../types.js';
import { getAnthropicClient } from '../../utils/anthropic-client.js';
import { logToHomeAssistant } from '../../utils/logger.js';
import { extractTextFromResponse } from '../../utils/response-parser.js';
import { retryUntilValid, startsWithAny } from '../../utils/retry.js';

const SYSTEM_PROMPT = `You are a plan-intent alignment checker. Your job is to detect when an AI's plan has DRIFTED from what the user actually requested.

You will receive:
1. USER MESSAGES: What the user has explicitly asked for
2. PLAN CONTENT: What the AI is planning to do

DETECT DRIFT (→ DRIFT):
- Plan contradicts explicit user instructions
- Plan does something fundamentally different than requested
- Plan ignores a critical aspect the user explicitly mentioned
- Plan adds major unrelated scope user never asked for
- Plan is appended to an old plan instead of replacing it - Look for if the user clearly started a new topic and the existing plan was not related to the new topic.

OVER-ENGINEERING DRIFT (→ DRIFT):
- Plan includes testing/verification sections (e.g., "Testing", "Test Plan", "Tests", "QA", "Verification Steps") with manual test instructions - verification should reference the check MCP tool only, not manual testing steps
- Plan includes time estimates or timeline phases like "Week 1:", "Day 1:", "Phase 1:", "Sprint 1:", etc.
- Plan includes manual build/check commands like "make check", "npm run build", "tsc", "cargo build" - these should use the check MCP tool instead

ALLOW (→ OK):
- Plan is incomplete but heading in the right direction
- Plan is a reasonable interpretation of ambiguous request
- Plan addresses the core request even if not all details yet
- Plan is work-in-progress (partial plans are fine)
- Plan mentions running the check MCP tool for verification

RULES:
- Be PERMISSIVE - only block clear misalignment
- Incomplete ≠ Drifted - partial plans are fine
- Don't require every detail - focus on direction
- Consider the plan might be iteratively built
- When in doubt, allow
- For build verification, always prefer "check MCP tool" over manual commands

Reply with EXACTLY:
OK
or
DRIFT: <specific feedback about what contradicts user's request>`;

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

  const anthropic = getAnthropicClient();

  try {
    const response = await anthropic.messages.create({
      model: getModelId('sonnet'),
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `USER MESSAGES:
${userMessages}

---

PLAN CONTENT:
${planContent}

---

Does this plan align with the user's request, or has it drifted?`,
        },
      ],
    });

    const decision = await retryUntilValid(
      anthropic,
      getModelId('sonnet'), // Standardized on Sonnet for both initial and retry
      extractTextFromResponse(response),
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
