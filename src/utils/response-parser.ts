/**
 * Response Parsing Utilities
 *
 * All hook agents parse Anthropic API responses the same way.
 * This module centralizes that logic to eliminate duplication
 * and ensure consistent behavior.
 */

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Result of parsing a decision from LLM output.
 */
export interface DecisionResult {
  /** Raw decision token (APPROVE, DENY, OK, BLOCK, etc.) */
  decision: string;
  /** True if the decision matches a positive token */
  approved: boolean;
  /** Extracted reason if present (e.g., from "DENY: reason") */
  reason?: string;
}

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
  const textBlock = response.content.find((block) => block.type === 'text');
  return textBlock && 'text' in textBlock ? textBlock.text.trim() : '';
}

/**
 * Parse a decision string into structured result.
 *
 * Hook agents output decisions in formats like:
 * - "APPROVE" or "OK" (positive)
 * - "DENY: reason" or "BLOCK: reason" (negative with reason)
 * - "DRIFT: feedback" or "INTERVENE: message" (negative with reason)
 *
 * @param text - The raw decision text from LLM
 * @param positiveTokens - Tokens that indicate approval (e.g., ['APPROVE', 'OK'])
 * @returns Structured decision result
 *
 * @example
 * ```typescript
 * // For tool-approve agent
 * const result = parseDecision(text, ['APPROVE']);
 * if (result.approved) { ... }
 *
 * // For error-acknowledge agent
 * const result = parseDecision(text, ['OK']);
 * if (!result.approved) {
 *   console.log(result.reason); // The BLOCK: reason
 * }
 * ```
 */
export function parseDecision(
  text: string,
  positiveTokens: string[]
): DecisionResult {
  const trimmed = text.trim();

  // Check if any positive token matches
  for (const token of positiveTokens) {
    if (trimmed.startsWith(token)) {
      return {
        decision: token,
        approved: true,
      };
    }
  }

  // Not approved - extract reason if present
  // Common patterns: "DENY: reason", "BLOCK: reason", "DRIFT: reason"
  const colonIndex = trimmed.indexOf(':');
  if (colonIndex > 0) {
    const decision = trimmed.substring(0, colonIndex).trim();
    const reason = trimmed.substring(colonIndex + 1).trim();
    return {
      decision,
      approved: false,
      reason: reason || undefined,
    };
  }

  // No colon found - return raw text as decision
  return {
    decision: trimmed,
    approved: false,
  };
}

/**
 * Extract reason from a prefixed decision string.
 *
 * Utility for cases where you know the format and just need the reason.
 *
 * @param text - Full decision string (e.g., "DENY: file outside project")
 * @param prefix - Prefix to strip (e.g., "DENY: ")
 * @returns The reason, or undefined if prefix not found
 *
 * @example
 * ```typescript
 * const reason = extractReason("DENY: sensitive file", "DENY: ");
 * // reason = "sensitive file"
 * ```
 */
export function extractReason(text: string, prefix: string): string | undefined {
  if (text.startsWith(prefix)) {
    return text.substring(prefix.length).trim() || undefined;
  }
  return undefined;
}
