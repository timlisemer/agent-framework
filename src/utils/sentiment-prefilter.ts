/**
 * Sentiment Pre-Filter — pure morphology-based mood hints.
 *
 * Computed BEFORE the SENTIMENT_AGENT runs and surfaced to the prompt as a
 * `MOOD HINT` block. The LLM remains primary for mood quality. Only the
 * "[Request interrupted by user] >= 2" rule is hard-overridden TS-side
 * because the SENTIMENT_AGENT prompt mandates that classification literally
 * ("Multiple '[Request interrupted by user for tool use]' entries always
 * indicate angry."). Other hints log disagreement only.
 *
 * @module sentiment-prefilter
 */

const ACCUSATION_RE =
  /\b(you\s+(didn'?t|did\s+not|ignored|keep|always|still)|i\s+told\s+you|why\s+(did|are)\s+you|you\s+promised\s+you\s+wouldn'?t)\b/i;
const SECOND_CORRECTION_RE =
  /\b(as\s+i\s+said|i\s+just\s+told\s+you|like\s+i\s+said\s+before|i\s+already\s+said)\b/i;
const APOLOGY_DEMAND_RE = /\b(apologi[sz]e|say\s+sorry|admit\s+(it|that))\b/i;
const REQUEST_INTERRUPTED_RE = /\[Request\s+interrupted\s+by\s+user/g;

export type MoodHint = "angry" | "frustrated" | null;

export function preClassifyMood(
  message: string,
): { hint: MoodHint; interruptCount: number } {
  const interruptCount = (message.match(REQUEST_INTERRUPTED_RE) || []).length;
  if (interruptCount >= 2) return { hint: "angry", interruptCount };
  if (ACCUSATION_RE.test(message)) return { hint: "angry", interruptCount };
  if (APOLOGY_DEMAND_RE.test(message)) return { hint: "angry", interruptCount };
  if (SECOND_CORRECTION_RE.test(message)) return { hint: "frustrated", interruptCount };
  return { hint: null, interruptCount };
}
