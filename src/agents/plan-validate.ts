import Anthropic from '@anthropic-ai/sdk';
import { getModelId } from '../types.js';
import { logToHomeAssistant } from '../utils/logger.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || null,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN || undefined,
  baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
});

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
- Plan includes extensive testing campaigns (e.g., "Testing Phase", "Test Plan", "QA Campaign") for relatively small changes (single file edits, minor fixes, simple additions)
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

    const textBlock = response.content.find((block) => block.type === 'text');
    let decision =
      textBlock && 'text' in textBlock ? textBlock.text.trim() : '';

    // Retry logic for malformed responses
    let retries = 0;
    const maxRetries = 2;

    while (
      !decision.startsWith('OK') &&
      !decision.startsWith('DRIFT:') &&
      retries < maxRetries
    ) {
      retries++;

      const retryResponse = await anthropic.messages.create({
        model: getModelId('haiku'),
        max_tokens: 150,
        messages: [
          {
            role: 'user',
            content: `Invalid format: "${decision}". Reply with exactly: OK or DRIFT: <feedback>`,
          },
        ],
      });

      const retryTextBlock = retryResponse.content.find(
        (block) => block.type === 'text'
      );
      decision =
        retryTextBlock && 'text' in retryTextBlock
          ? retryTextBlock.text.trim()
          : '';
    }

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
  } catch (error) {
    // On error, fail open (allow the write)
    logToHomeAssistant({
      agent: 'plan-validate',
      level: 'error',
      problem: 'Validation error',
      answer: String(error),
    });

    return { approved: true };
  }
}
