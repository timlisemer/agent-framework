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

// ALL-CAPS shouting: at least 4 consecutive ALL-CAPS tokens of >=3 letters
// each, separated by non-word characters, AND at least 85% of letters in
// the message are uppercase. The token-pattern alone false-positives on
// calm tech-acronym sentences ("Use HTTPS API REST JSON YAML XML
// responses." has 6 consecutive caps tokens but 66% uppercase ratio); the
// letter-ratio guard rejects those.
//
// Catches: "STOP. WTF ARE YOU DOING.", "WHY THE FUCK DID YOU STOP HOW
// FUCKING OFTEN", "OH MY FUCKING GOD WHY ARE YOU CALLING VITETEST",
// "NO I DID NOT ASK THAT. FUCKING REPEAT WHAT I ASKED." (all 100% caps).
// Rejects: "Use HTTPS API REST JSON responses.", "Set FOO BAR BAZ env
// vars.", "Check the JSON HTTP API endpoint." (calm tech-acronym sentences
// dominated by lowercase context).
const SHOUTING_TOKEN_RE = /(?:\b[A-Z]{3,}\b[^\w]+){3,}\b[A-Z]{3,}\b/;
function isAllCapsShouting(message: string): boolean {
  const m = SHOUTING_TOKEN_RE.exec(message);
  if (!m) return false;
  const letters = message.replace(/[^A-Za-z]/g, "");
  if (letters.length < 12) return false;
  const uppers = letters.replace(/[^A-Z]/g, "").length;
  // Two conditions can satisfy shouting:
  // 1. High ratio (>=85%) of uppercase letters across the full message —
  //    catches messages that are entirely uppercase ("NO I DID NOT ASK THAT
  //    FUCKING REPEAT WHAT I ASKED").
  // 2. The all-caps token run starts at or within the first 3 characters of
  //    the message — catches messages that START with all-caps shouting but
  //    have a calm suffix appended ("STOP. WTF ARE YOU DOING. now fix this.").
  //    The "starts near beginning" guard is absent from tech-acronym sentences
  //    like "Use HTTPS API REST JSON YAML XML responses." where the acronym
  //    run begins after a lowercase word (position 4).
  const highRatio = uppers / letters.length >= 0.85;
  const startsNearBeginning = m.index <= 3;
  return highRatio || startsNearBeginning;
}

export type MoodHint = "angry" | "frustrated" | null;

export function preClassifyMood(
  message: string,
): { hint: MoodHint; interruptCount: number } {
  const interruptCount = (message.match(REQUEST_INTERRUPTED_RE) || []).length;
  if (interruptCount >= 2) return { hint: "angry", interruptCount };
  if (ACCUSATION_RE.test(message)) return { hint: "angry", interruptCount };
  if (APOLOGY_DEMAND_RE.test(message)) return { hint: "angry", interruptCount };
  if (isAllCapsShouting(message)) return { hint: "angry", interruptCount };
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
  return directives[directives.length - 1];
}

/**
 * AI-directed insult / contempt vocabulary. Narrow on purpose: only words
 * that unambiguously address the AI as the target of contempt. Adjective-
 * form profanity ("absolutely fucking stalling") and adjective-form
 * descriptors ("useless", "pathetic", "incompetent", "lying") are NOT in
 * this set — those routinely appear in calm-but-frustrated bug reports
 * describing broken code or output ("this output is useless, please
 * regenerate") and would over-block the calm-override.
 *
 * Kept on purpose: noun-form insults (`idiot`, `moron`, `fool`,
 * `imbecile`, `jerk`, `asshole`, `asshat`, `shithead(s)`, `dumbass`,
 * `stupid`, `liar`) and the literal phrase `fuck you`.
 */
const AI_INSULT_RE =
  /\b(idiot|moron|fool|imbecile|jerk|asshole|asshat|shithead|shitheads|dumbass|stupid|liar|fuck\s+you)\b/i;

/**
 * Pure-morphology calm-directive detector. Returns true when the stripped
 * LATEST message is unambiguously a calm first-person directive with no
 * first-person hostility aimed at the live AI.
 *
 * Used as a HARD post-parse override in user-prompt-submit (Finding 15):
 * when this fires, SENTIMENT_AGENT's output is demoted angry/frustrated ->
 * neutral and low -> normal. Same pattern as Findings 6/7/14 — a TS-side
 * deterministic classifier overrides Haiku's non-deterministic output for
 * the unambiguous case.
 *
 * ALL of the following must hold:
 *   a. preClassifyMood returned hint=null     (no first-person hostility)
 *   b. interruptCount === 0                    (no [Request interrupted])
 *   c. directiveHint is non-empty              (a live imperative exists)
 *   d. AI_INSULT_RE does not match             (no AI-directed insults)
 *
 * Note: predicate (b) is INTENTIONALLY tighter than (a). preClassifyMood
 * already returns hint=angry when interruptCount>=2 (so >=2 is caught by
 * predicate (a)). Predicate (b) blocks the additional case interruptCount
 * === 1 — a single [Request interrupted by user] is a strong signal that
 * the user just halted something the AI did, and a calm-looking
 * follow-on directive ("please retry") should not be treated as a fresh
 * calm context that resets mood/trust to neutral. Either drop (b) only
 * if you decide single interrupts are noise; otherwise keep as-is.
 */
export function preClassifyCalm(
  stripped: string,
  directiveHint: string,
): boolean {
  if (!stripped || !directiveHint) return false;
  const m = preClassifyMood(stripped);
  if (m.hint !== null) return false;
  if (m.interruptCount !== 0) return false;
  if (AI_INSULT_RE.test(stripped)) return false;
  return true;
}
