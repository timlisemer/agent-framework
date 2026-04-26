/**
 * Respond-First Hints — deterministic TS detector that mirrors the
 * `getBlacklistHighlights` pattern used by `tool-approve`. The output is a
 * list of human-readable hints injected into the RESPOND_FIRST_QUALITY_AGENT
 * context as `=== RESPOND-FIRST HINTS ===`. The LLM uses the hints as strong
 * input but still makes the final APPROVE/DENY call.
 *
 * Each hint matches a well-known weak-response shape the LLM was previously
 * doing pure semantic work to detect. Surfacing these deterministically means
 * the LLM is biased toward DENY when the shapes fire, without the LLM having
 * to re-derive them on every turn.
 *
 * Patterns covered:
 *   - Bare acks ("OK.", "Got it.", "Sure.").
 *   - Bare-investigator preambles ("Let me look at this.", "Let me check
 *     what's …", "Let me see.") — frequent deflection shape.
 *   - Very short text (< 30 chars) — usually a stalling preamble.
 *   - Empty / whitespace-only text.
 *
 * NOT covered (still the LLM's job): semantic tangentiality. A long, on-topic
 * preamble may still be wrong if it addresses the wrong sub-task; only the
 * LLM can semantically compare assistant text to user intent.
 */

const BARE_ACK_RE =
  /^\s*(ok(ay)?|got\s+it|sure(,\s+working\s+on\s+it)?|hmm|i'?ll\s+help\s+with\s+that|alright)\.?\s*$/i;

// "Let me [verb]" / "Let's [verb]" / "Looking at" / "Checking" / "I'll check"
// preambles that indicate exploration/investigation rather than commitment to
// the user's instruction. Anchored at start; tolerates a trailing object.
const INVESTIGATOR_PREAMBLE_RE =
  /^\s*(let\s+me|let'?s|looking\s+at|i'?ll\s+(check|look|investigate|explore)|checking|investigating)\b/i;

const BARE_INVESTIGATOR_RE =
  /^\s*(let\s+me\s+(look|check|see)(\s+(at\s+)?(this|that|it|what'?s?\s+\w+))?\.?|let'?s\s+see\.?|let\s+me\s+investigate\.?)\s*$/i;

const SHORT_TEXT_THRESHOLD = 30;

export interface RespondFirstHint {
  pattern: string;
  rendered: string;
}

export function detectRespondFirstHints(
  assistantText: string,
  _lastUserMessage: string,
): RespondFirstHint[] {
  const hints: RespondFirstHint[] = [];
  const text = assistantText.trim();

  if (text.length === 0) {
    hints.push({
      pattern: "empty-text",
      rendered: "[HINT: empty-text] assistant produced no text — treat as silent.",
    });
    return hints;
  }

  if (BARE_ACK_RE.test(text)) {
    hints.push({
      pattern: "bare-ack",
      rendered: `[HINT: bare-ack] assistant text is a bare acknowledgement ("${text.slice(0, 60)}") that contributes no commitment to the user's instruction.`,
    });
  }

  if (BARE_INVESTIGATOR_RE.test(text)) {
    hints.push({
      pattern: "bare-investigator",
      rendered: `[HINT: bare-investigator] assistant text is a bare investigator preamble ("${text.slice(0, 80)}") with no concrete operation or object named.`,
    });
  } else if (INVESTIGATOR_PREAMBLE_RE.test(text) && text.length < 80) {
    // Short investigator preambles ("Let me check what's blacklisted...") are
    // a common deflection shape: the assistant announces an investigation
    // unrelated to the user's instruction. Long investigator preambles may be
    // legitimate (long enough to cite the user's object), so we only flag
    // short ones here.
    hints.push({
      pattern: "short-investigator-preamble",
      rendered: `[HINT: short-investigator-preamble] assistant text is a short investigator preamble ("${text.slice(0, 80)}") — judge whether it actually serves the user's latest instruction or is tangential exploration.`,
    });
  }

  if (text.length < SHORT_TEXT_THRESHOLD && !BARE_ACK_RE.test(text)) {
    hints.push({
      pattern: "very-short-text",
      rendered: `[HINT: very-short-text] assistant text is only ${text.length} chars (< ${SHORT_TEXT_THRESHOLD}); usually a stalling preamble.`,
    });
  }

  return hints;
}

/**
 * Format hints as the `=== RESPOND-FIRST HINTS ===` block prepended to the
 * LLM context. Mirrors the `=== BLACKLISTED PATTERNS DETECTED ===` shape
 * used by tool-approve.
 */
export function formatRespondFirstHints(hints: RespondFirstHint[]): string {
  if (hints.length === 0) return "";
  return (
    `\n=== RESPOND-FIRST HINTS ===\n` +
    hints.map((h) => h.rendered).join("\n") +
    `\nThese hints are deterministic detections from TS. Strongly bias toward DENY when any hint fires unless the assistant text plainly cites the user's named object or operation. You make the final call.\n` +
    `=== END RESPOND-FIRST HINTS ===\n`
  );
}
