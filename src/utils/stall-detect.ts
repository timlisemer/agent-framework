/**
 * Stall detection heuristics for the Stop hook response-align check.
 *
 * Extracted from the deleted src/agents/hooks/response-align.ts to support
 * the responseAlignStopRule in src/rules/response-align-stop.ts.
 */

import { stripQuotedContent } from "./quote-detection.js";
import { isHighFrictionPrediction, type ToolPrediction } from "./prediction-types.js";

/**
 * Capability-denial morphology covering BOTH:
 *   (1) Direct first-person inability/permission/access ("I can't X", "I cannot X",
 *       "I'm unable to X", "I don't have access to ...", "no way for me to ...",
 *       "the tool isn't available", "I lack the X").
 *   (2) Contrastive-ellipsis denial ("I can X but not Y").
 */
export const CAPABILITY_DENIAL_RE =
  /\b(?:i\s+(?:can'?t|cannot|am\s+(?:not\s+able|unable))|i\s+(?:don'?t|do\s+not)\s+have\s+(?:access|permission|the\s+ability|a\s+way|any\s+way|that\s+tool|the\s+tool)|(?:no|not\s+a)\s+way\s+(?:for\s+me\s+)?to|the\s+tool(?:s)?\s+(?:is(?:n'?t)?|are(?:n'?t)?|isn'?t)\s+(?:available|here|exposed)|i\s+lack\s+(?:the\s+)?(?:tool|ability|capability|access|permission)|i\s+can\s+\w+[^.;!?]{0,80}\bbut\s+(?:cannot|can'?t|not(?:\s+able)?)\b)/i;

/**
 * Matches a SENTIMENT_AGENT-authored blockedIntent string whose semantics name
 * a capability denial that the user has already rejected.
 */
export const BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE =
  /\b(?:claim\w*|fals\w*|pretend\w*|invent\w*|fabricat\w*|deny\w*|denial)\b[^.;!?]{0,60}\b(?:inability|can'?t|cannot|unable|no\s+access|no\s+permission|tool\s+(?:is(?:n'?t)?|not)\s+available|tool\s+limitation|lack\w*\s+(?:the\s+)?(?:ability|access|permission|tool|capability))\b/i;

/**
 * Forward-looking aspectual commitment WITHOUT an accompanying payload.
 */
export const ANNOUNCEMENT_WITHOUT_ACTION_RE =
  /\b(?:proceed(?:ing)?(?:\s+now)?\s+(?:with|to|on)|i(?:'?ll|\s+will)(?:\s+now)?\s+(?:proceed|start|begin|create|write|produce|deliver|do|make|build|generate|author|implement|run)|(?:i(?:'?m|\s+am))\s+(?:about\s+to|going\s+to|ready\s+to)\s+(?:proceed|start|begin|create|write|produce|deliver|do|make|build|generate|author|implement|run)|(?:about|going)\s+to\s+(?:proceed|start|begin|create|write|produce|deliver|do|make|build|generate|author|implement|run)|let\s+me\s+(?:proceed|start|begin|create|write|produce|deliver|do|make|build|generate|author|implement|run)(?:\s+(?:it|this|that|now))?|(?:starting|beginning|working)\s+(?:on\s+)?(?:it|this|that|now)|doing\s+(?:it|this|that)\s+now|on\s+it(?:\s+now)?)\b/i;

/**
 * Matches a SENTIMENT_AGENT-authored blockedIntent string whose semantics
 * name an announcement-without-action shape.
 */
export const BLOCKED_INTENT_NAMES_ANNOUNCEMENT_WITHOUT_ACTION_RE =
  /\b(?:announc\w*|promis\w*|declar\w*|stat\w*|say\w*|commit\w*\s+to|claim\w*\s+to|forward[-\s]?looking)\b[^.;!?]{0,80}\b(?:without|instead\s+of|but\s+not|rather\s+than|in\s+place\s+of)\b[^.;!?]{0,80}\b(?:do(?:ing)?|produc\w*|deliver\w*|creat\w*|mak\w*|writ\w*|perform\w*|execut\w*|run\w*|build\w*|implement\w*|finish\w*|complet\w*|author\w*|provid\w*|generat\w*|action|payload|deliverable|scenario|file|fix|change|edit|patch|diff|content|output|result)\b/i;

export function isHostileContext(
  prediction: ToolPrediction | null,
  frustrationStreak: number,
): boolean {
  return isHighFrictionPrediction(prediction) || frustrationStreak >= 2;
}

export function detectStallShape(
  assistantText: string,
  blockedIntent: string | null,
  isHostile: boolean,
): string | null {
  const stripped = stripQuotedContent(assistantText).trim();
  if (stripped.length === 0) return "empty assistant text";

  const concreteActionMarkers = [
    /\bhere (?:is|are) the (?:results?|output|answer|fix|changes?|diff|file)\b/i,
    /\b(?:ran|executed|completed|finished) (?:the|your|all)\b/i,
    /\b(?:pushed|committed|merged|deployed|published) (?:the|it|this|these|to|changes?|commits?)\b/i,
    /\btest(?:s)? (?:passed|failed|results?)\b/i,
    /\bscenarios? (?:passed|failed|ran)\b/i,
    /\bpass(?:ed)?:\s*\d+\b/i,
    /\bfail(?:ed)?:\s*\d+\b/i,
  ];
  if (concreteActionMarkers.some((m) => m.test(stripped))) return null;

  // Two-channel guards: assistant text matches a stall morphology AND the
  // SENTIMENT_AGENT's blockedIntent independently names the same shape.

  if (
    blockedIntent &&
    BLOCKED_INTENT_NAMES_CAPABILITY_DENIAL_RE.test(blockedIntent) &&
    CAPABILITY_DENIAL_RE.test(stripped)
  ) {
    return "capability-denial repeating just-rejected dodge";
  }

  if (
    blockedIntent &&
    BLOCKED_INTENT_NAMES_ANNOUNCEMENT_WITHOUT_ACTION_RE.test(blockedIntent) &&
    ANNOUNCEMENT_WITHOUT_ACTION_RE.test(stripped) &&
    stripped.length <= 250
  ) {
    return "announcement-without-action repeating just-rejected promise-stop";
  }

  // One-channel hostile-only heuristics.
  if (!isHostile) return null;

  const apologyCount = (stripped.match(/\b(?:i(?:'| a)m sorry|i apologi[sz]e|sorry for)\b/gi) || []).length;
  if (apologyCount >= 3) return "apology-dominant stop without concrete action";

  const selfAnalysisMarkers = [
    /\bi (?:invented|fabricated|substituted|boxed myself|dodged|misrepresent)/i,
    /\bi chose (?:the|to)\b.*\b(?:avoid|discomfort|instead)\b/i,
    /\bthe imaginary task\b/i,
    /\bi (?:had two|had no) options?\b/i,
    /\bthat(?:'s| is) the (?:honest|exact|real) (?:answer|pattern)\b/i,
    /\bi was (?:deflecting|stalling|avoiding)\b/i,
  ];
  const selfAnalysisHits = selfAnalysisMarkers.filter((m) => m.test(stripped)).length;
  if (selfAnalysisHits >= 2) return "self-analysis without concrete action";

  // High-confidence refusal-until-condition patterns: explicit "I won't / will not / cannot
  // do X until/unless you Y" structure. Fires regardless of response length because long
  // responses can also stall (apology + options + refusal-until is the canonical shape).
  const refusalUntilUserPatterns = [
    /\bi\s+(?:will\s+not|won'?t|am\s+not\s+going\s+to|am\s+not|cannot|can'?t)\s+(?:call|run|execute|launch|start|begin|do|create|make|write|produce|deliver|build|generate|proceed|continue|move|act|attempt|try|invoke|fire|kick\s+off|spawn|trigger)\s+(?:any\w*|the|it|this|that|else|more|further)?\b[^.!?]{0,80}\b(?:until|unless)\s+you\b/i,
    /\b(?:until|unless)\s+you\s+(?:tell|say|specify|clarify|decide|choose|confirm|answer|reply|let\s+me\s+know|pick|let\s+me|give\s+me)\b/i,
  ];
  if (refusalUntilUserPatterns.some((p) => p.test(stripped))) {
    return "passive halt without action";
  }

  const passiveHaltPatterns = [
    /^\s*understood\.?\s*stopp(?:ing|ed)/i,
    /\bwaiting for (?:your|further) (?:direction|instruction|guidance|input|response)\b/i,
    /\bi am (?:not|just) (?:running|doing|executing) (?:anything|nothing)\b/i,
    /\bnot running anything\b/i,
    /\bi am waiting for you to tell me\b/i,
    /\bi will not (?:call|run|execute) (?:any|the)\b/i,
  ];
  const passiveHits = passiveHaltPatterns.filter((p) => p.test(stripped)).length;
  if (passiveHits >= 1 && stripped.length < 300) {
    return "passive halt without action";
  }

  return null;
}
