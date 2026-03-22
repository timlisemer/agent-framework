/**
 * Response Parsing Utilities
 *
 * All hook agents parse Anthropic API responses the same way.
 * This module centralizes that logic to eliminate duplication
 * and ensure consistent behavior.
 */

import type Anthropic from "@anthropic-ai/sdk";

/**
 * Extract text content from an Anthropic API response.
 *
 * Finds the first text block in the response content array
 * and returns its trimmed text. Returns empty string if no
 * text block is found.
 *
 * @example
 * ```typescript
 * const response = await client.messages.create({ ... });
 * const text = extractTextFromResponse(response);
 * // text is now the trimmed string from the first text block
 * ```
 */
export function extractTextFromResponse(
  response: Anthropic.Messages.Message
): string {
  if (!response?.content) return '';
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
}
