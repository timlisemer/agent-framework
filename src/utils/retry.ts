/**
 * Retry Logic for LLM Format Validation
 *
 * ## WHY RETRY?
 *
 * LLMs sometimes produce malformed output:
 * - Extra preamble before the decision ("Let me think... APPROVE")
 * - Wrong format ("I approve this" instead of "APPROVE")
 * - Explanations after when not requested
 *
 * A quick retry with an explicit format reminder usually fixes this.
 * Max 2 retries is sufficient - if it fails 3 times, the model
 * fundamentally misunderstands the task.
 *
 * ## USAGE
 *
 * ```typescript
 * const decision = await retryUntilValid(
 *   client,
 *   getModelId('haiku'),
 *   extractTextFromResponse(response),
 *   "Read tool with path /etc/passwd",
 *   {
 *     formatValidator: (text) =>
 *       text.startsWith('APPROVE') || text.startsWith('DENY:'),
 *     formatReminder: 'Reply with EXACTLY: APPROVE or DENY: <reason>',
 *   }
 * );
 * ```
 */

import type Anthropic from "@anthropic-ai/sdk";
import { extractTextFromResponse } from "./response-parser.js";

/**
 * Options for retry behavior.
 */
export interface RetryOptions {
  /**
   * Maximum number of retry attempts.
   * Default: 2 (so 3 total attempts including initial)
   */
  maxRetries?: number;

  /**
   * Function to validate if the response format is acceptable.
   * Return true if format is valid, false to trigger retry.
   */
  formatValidator: (text: string) => boolean;

  /**
   * Message to send on retry, reminding the model of expected format.
   * Should be concise and explicit about the required format.
   */
  formatReminder: string;

  /**
   * Max tokens for retry requests.
   * Default: 100 (retries should be shorter than initial)
   */
  maxTokens?: number;
}

/**
 * Retry an LLM request until the response matches expected format.
 *
 * @param client - Anthropic client instance
 * @param model - Model ID to use for retries
 * @param initialResponse - The initial response text to validate
 * @param context - Context about what was being evaluated (for error message)
 * @param options - Retry configuration
 * @returns The final response text (may still be invalid if max retries exceeded)
 */
export async function retryUntilValid(
  client: Anthropic,
  model: string,
  initialResponse: string,
  context: string,
  options: RetryOptions
): Promise<string> {
  const { maxRetries = 2, formatValidator, formatReminder, maxTokens = 100 } = options;

  let decision = initialResponse;
  let retries = 0;

  while (!formatValidator(decision) && retries < maxRetries) {
    retries++;

    const retryResponse = await client.messages.create({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: 'user',
          content: `Invalid format: "${decision}". You are evaluating: ${context}. ${formatReminder}`,
        },
      ],
    });

    decision = extractTextFromResponse(retryResponse);
  }

  return decision;
}

/**
 * Check if a decision string starts with any of the given prefixes.
 *
 * Utility for creating format validators.
 *
 * @example
 * ```typescript
 * const validator = (text: string) => startsWithAny(text, ['APPROVE', 'DENY:']);
 * ```
 */
export function startsWithAny(text: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => text.startsWith(prefix));
}
