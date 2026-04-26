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

/**
 * Directive verbs the user typically uses to command an action.
 * Narrow on purpose - these are imperative-action verbs, not generic
 * communication verbs.
 */
const DIRECTIVE_VERB_RE =
  /\b(create|make|fix|update|remove|delete|add|change|edit|write|build|run|check|test|deploy|implement|review|continue|proceed|start|stop|push|pull|merge|rebase|split|extract|refactor|rename|move|copy|read|show|list|find|search|investigate|analyze|verify|confirm|cancel|undo|redo|retry|restart|kill|launch|spawn|invoke|use|consider|ensure|ignore|skip|give|provide|tell|explain|describe|clarify|simplify|generalize|harden|untether|untie|wire|hook|expose|publish|surface|land|ship|approve|reject|accept|abandon|drop|keep|preserve|restore|generate|emit|print|log|trace|debug|profile|measure|benchmark|optimize|fix|repair|clean|tidy|prune|gc|vacuum|reset|reload|reboot|sync|fetch|grab|attach|detach|link|unlink|connect|disconnect|enable|disable|toggle|flip|swap|replace|substitute|inject|patch|backport|forwardport|cherry-pick|squash|amend|revert|rollback)\b/i;

/**
 * Extract the most likely user directive from a stripped message. Used as
 * a HINT for SENTIMENT_AGENT's INTENT field when the message contains
 * heavy 3rd-person recap or quoted content that risks confusing the LLM.
 *
 * Strategy: split on sentence boundaries, find sentences that contain a
 * directive verb in 1st-person/2nd-person framing ("please X", "now X",
 * "go X", "i want you to X", or a bare imperative). Return the LAST
 * matching sentence (often the actual ask after preamble/recap), trimmed
 * to a reasonable length. Returns "" when no directive sentence is found.
 *
 * Used as a HINT to the LLM (not as a hard intent override) - the LLM
 * remains primary for intent quality. The hint just surfaces the relevant
 * substring so the LLM doesn't miss it inside heavy recap text.
 */
export function extractDirectiveHint(stripped: string): string {
  if (!stripped) return "";
  const sentences = stripped
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const directives: string[] = [];
  for (const s of sentences) {
    const lower = s.toLowerCase();
    const startsImperative =
      /^(please\b|now\s+|go\s+|just\s+|i\s+want\s+you\s+to\b|i\s+want\s+to\b|can\s+you\b|could\s+you\b|would\s+you\b|let'?s\b|let\s+me\b)/i.test(s) ||
      /^(create|make|fix|update|remove|delete|add|change|edit|write|build|run|check|test|deploy|implement|review|continue|start|stop|push|pull|merge|read|show|find|search|investigate|verify|generate|land|ship|enable|disable|toggle|replace|patch|undo|redo|retry|restart|launch|spawn|use|ignore|skip|give|provide|tell|explain|describe|clarify|consider|ensure)\b/i.test(s);
    if (startsImperative && DIRECTIVE_VERB_RE.test(lower)) {
      directives.push(s);
    }
  }
  if (directives.length === 0) return "";
  const picked = directives[directives.length - 1];
  return picked.length > 240 ? picked.slice(0, 240).trim() + "..." : picked;
}
