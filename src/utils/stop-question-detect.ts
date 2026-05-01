/**
 * Question detection heuristics for the Stop hook response-align check.
 *
 * Extracted from the deleted src/agents/hooks/response-align.ts to support
 * the responseAlignStopRule in src/rules/response-align-stop.ts.
 */

import { stripQuotedContent } from "./quote-detection.js";

/**
 * Patterns indicating AI is asking plain text questions (should use AskUserQuestion).
 */
export const PLAIN_TEXT_QUESTION_PATTERNS = [
  /would you like\b/i,
  /should I\b/i,
  /do you want\b/i,
  /do you prefer\b/i,
  /shall I\b/i,
  /let me know if\b/i,
  /what would you prefer/i,
  /how would you like/i,
  /which (?:option|approach)/i,
  /what do you think/i,
  /any preference/i,
  /\bor\s+you\s+can\b/i,
  /\bonly\s+(?:two|three|\d+)\s+(?:options|choices|ways)\b/i,
];

/**
 * Conversational patterns that weaken question detection hints.
 */
export const CONVERSATIONAL_EXEMPTIONS = [
  /would you like me to explain/i,
  /would you like more detail/i,
  /should I go into more detail/i,
  /let me know if you.*(need|want|have)/i,
  /can I help with anything else/i,
  /what (?:do you want|should|would you like).*(?:explore|investigate|look at)/i,
  /what should the.*agent/i,
];

/**
 * Patterns indicating AI is asking for plan approval in plain text.
 */
export const PLAN_APPROVAL_PATTERNS = [
  /does this (?:plan |approach )?(?:look|sound) (?:good|ok|right)/i,
  /(?:ready to )?proceed with this/i,
  /(?:can|shall) I (?:proceed|continue|start)/i,
  /approve this (?:plan|approach)/i,
  /continue with (?:this|the) (?:plan|approach|implementation)/i,
];

/**
 * Extract the main question from user text (for error messages).
 */
export function extractUserQuestion(text: string): string | null {
  const stripped = stripQuotedContent(text);
  const sentences = stripped.split(/[.!]\s+/);

  for (const sentence of sentences) {
    if (sentence.includes("?")) {
      return sentence.trim();
    }
  }

  const questionMatch = stripped.match(
    /\b(what|why|how|where|when|which|who|can you|could you|would you)[^.!?]+/i
  );
  if (questionMatch) {
    return questionMatch[0].trim();
  }

  return null;
}

/**
 * Check if assistant response ends with a question or contains question patterns.
 * When a conversational exemption matches, the detection is weakened (returned as
 * "conversational" type) so the LLM classifier is not biased toward QUESTION.
 */
export function hasPlainTextQuestion(assistantText: string): {
  detected: boolean;
  type?: "question" | "plan_approval" | "conversational";
} {
  const trimmed = assistantText.trim();

  for (const pattern of PLAN_APPROVAL_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { detected: true, type: "plan_approval" };
    }
  }

  const isConversational = CONVERSATIONAL_EXEMPTIONS.some((p) => p.test(trimmed));

  for (const pattern of PLAIN_TEXT_QUESTION_PATTERNS) {
    if (pattern.test(trimmed)) {
      if (isConversational) {
        return { detected: true, type: "conversational" };
      }
      return { detected: true, type: "question" };
    }
  }

  if (trimmed.endsWith("?")) {
    const lastSentence = trimmed.split(/[.!]\s+/).pop() || "";
    if (
      !lastSentence.match(/^(?:why|how) (?:does|is|would) (?:this|that)/i) &&
      !lastSentence.match(/^(?:I wonder|wondering)/i)
    ) {
      if (isConversational) {
        return { detected: true, type: "conversational" };
      }
      return { detected: true, type: "question" };
    }
  }

  return { detected: false };
}
