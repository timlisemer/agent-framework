/**
 * Prediction Types - Sentiment-aware prediction shape and pure decision logic.
 *
 * Pure functions only — no I/O, no LLM calls, no caches. The LLM
 * (SENTIMENT_AGENT) produces a `ToolPrediction` which is stored on
 * `SessionState.currentPrediction`; callers use `decidePrediction` to enforce
 * a small hardcoded mood × tool-class policy with explicit allow/block lists.
 *
 * @module prediction-types
 */

import { isLowRiskTool, isLowRiskInspectionTool } from "../rules/utils.js";
import { CANONICAL_MCPS } from "../adapter/types.js";
import {
  isEditTool,
  deriveEditIntentFromPrediction,
  deriveAllowedToolsFromIntent,
  EDIT_VERB_RE,
  RENAME_MOVE_VERB_RE,
  TEST_RUN_VERB_RE,
  BASH_INSPECTION_VERB_RE,
  COMMIT_VERB_RE,
  PUSH_VERB_RE,
  CHECK_VERB_RE,
  READ_VERB_RE,
} from "./edit-intent.js";
import { classifyBashCommand, evaluateBashPolicy, type BashCommandClassification } from "./command-patterns.js";

export type Mood = "angry" | "frustrated" | "neutral" | "satisfied" | "happy";
export type Trust = "low" | "normal" | "high";

export interface ToolRequirement {
  /** Canonical tool name such as "Agent", "Read", or "mcp-commit". */
  tool: string;
  /** Exact scalar input constraints. Example: { subagent_type: "implementer" }. */
  input?: Record<string, string | number | boolean>;
  /** Exact array-length constraints on canonical input fields. */
  inputArrayLengths?: Record<string, number>;
  /** Literal substrings that must appear in the serialized tool input. */
  inputSubstrings?: string[];
  /** Human-readable source/reason for debugging and prediction context. */
  reason?: string;
}

export interface PredictionToolCall {
  toolName: string;
  toolInput: unknown;
}

export interface ToolPrediction {
  mood: Mood;
  trust: Trust;
  /** 1-2 sentences: what the user wants. */
  intent: string;
  /** 1-2 sentences: what the user explicitly does NOT want, or "". */
  blockedIntent: string;

  /** LITERAL tool names — exact match, no regex. */
  explicitlyAllowedTools: string[];

  /**
   * Ordered tool calls that must happen before arbitrary workflow progress.
   * The first entry is the only required call currently accepted. Calls
   * matching nonBlockingTools may run without consuming this queue.
   */
  explicitlyRequiredTools?: ToolRequirement[];

  /**
   * Tool calls allowed while explicitlyRequiredTools is non-empty. These do
   * not consume the required queue.
   */
  nonBlockingTools?: ToolRequirement[];

  /** LITERAL substring filters — no regex. */
  explicitlyBlockedSubstrings: Array<{
    /** Exact tool name like "Bash" or "Edit". */
    tool: string;
    /** Literal substring of command/file_path. */
    targetSubstring?: string;
    /** Quote of user's words explaining the block. */
    reason: string;
  }>;

  /**
   * Set by SENTIMENT_AGENT when the user explicitly asked the AI to stop
   * doing things entirely ("stop", "don't do anything", "halt everything",
   * "STOP. WTF ARE YOU DOING."). When true, decidePrediction denies EVERY
   * tool not in explicitlyAllowedTools — overrides the low-risk allowance.
   */
  blockAllTools?: boolean;

  /**
   * Full unstripped user message used for policy logic. Optional for
   * backwards-compatible scenario seeds; logic must fall back to
   * userMessageSnippet only when this is absent.
   */
  userMessageFull?: string;

  /** Short display quote for denial text and reports. Do not use as logic. */
  userMessageSnippet: string;
  timestamp: number;

  /** Whether the user just changed topic / opened a new unrelated task. */
  contextSwitch?: "yes" | "no";
  /**
   * Only meaningful when SENTIMENT_AGENT was invoked with ASKUSERQUESTION CONTENT.
   * Otherwise "n/a".
   */
  questionIsStalling?: "yes" | "no" | "n/a";

  /**
   * True when the user's full prompt (NOT the 200-char snippet) contains an
   * explicit override phrase ("override the block", "do it anyway", etc.).
   * Computed once at prediction-population time against the full prompt so
   * downstream consumers (tool-appeal user-state, future outside-root rules)
   * read a single source of truth.
   */
  hasExplicitOverride?: boolean;
}

function bashSafetyBlocksPredictionOverride(
  classification: BashCommandClassification,
  command: string,
): boolean {
  if (classification.riskClass === "blocked") return true;
  const terminal = evaluateBashPolicy(command).terminal;
  if (classification.blacklistHighlights.some((highlight) => highlight.startsWith("[CHECK-ROUTED:")) && terminal.ownerTopic !== "check-routed") return true;
  if (classification.workaroundCategory) return terminal.ownerTopic !== "check-routed";
  if (classification.riskClass !== "high-risk-workaround") return false;
  return terminal.ownerTopic !== "check-routed";
}

export interface PredictionDecision {
  decision: "allow" | "deny";
  reason?: string;
  matchedExplicit?: { tool: string; targetSubstring?: string; reason: string };
}

export interface LatestUserTurn {
  /** Exact latest transcript user text. */
  rawText: string;
  /** Quote/paste-stripped text used for live authorization/prohibition logic. */
  logicText: string;
  /** Short display quote for denial text. */
  displaySnippet: string;
  /** Whether rawText appears to be the same user turn that populated currentPrediction. */
  matchesCachedPrediction: boolean;
}

export function predictionUserMessageForLogic(prediction: ToolPrediction): string {
  return prediction.userMessageFull ?? prediction.userMessageSnippet;
}

/**
 * Verbs that — applied to file changes the AI made — REQUIRE Edit/Write to obey.
 * Mirrors the SENTIMENT_AGENT prompt's undo verb-mapping in
 * src/utils/agent-configs.ts:1444-1445 (commit 2e27eae) and the morphology
 * style of deriveEditIntentFromPrediction (src/utils/edit-intent.ts:83).
 * Keep this list in sync with the prompt — if the prompt grows a verb, this
 * regex must too.
 *
 * Reconciles the case where prose `intent` and structured
 * `explicitlyAllowedTools` disagree: if the prose says undo/revert and the
 * requested tool can edit, honor the prose instead of denying.
 */
const UNDO_INTENT_RE =
  /\b(undo\w*|undone|revert\w*|restor\w*|rollback\w*|roll\s+back|put\s+back|rewrit\w*|redo\w*)\b/i;

/**
 * Cessation-verb + inactivity-noun morphology that semantically inverts
 * "stop X" from "prohibit activity X" to "demand the user's underlying
 * action proceed". Mirrors UNDO_INTENT_RE; keep in sync with the
 * SENTIMENT_AGENT prompt's BLOCK-ALL-TOOLS guidance in
 * src/utils/agent-configs.ts.
 *
 * Noun list is intentionally narrow: only UNAMBIGUOUS inactivity nouns.
 * Verbs like "wait" / "freeze" are reserved for category-A prohibitions
 * (see SENTIMENT_AGENT BLOCK-ALL-TOOLS markers) and MUST NOT appear here.
 * Phrase-anchored idioms ("dragging your feet", "spinning your wheels")
 * are spelled out so a bare "drag" / "spin" (which can read as activity
 * verbs) doesn't over-fire.
 */
export const INACTION_COMPLAINT_RE =
  /\b(stop|stops|stopped|stopping|quit|quits|quitting|halt|halts|halting|cease|ceases|ceased|ceasing|cut\s+out|no\s+more|enough\s+of)\b[^.!?]{0,40}\b(stall\w*|dither\w*|stonewall\w*|hesitat\w*|deflect\w*|dawdl\w*|procrastinat\w*|dragging\s+(your|its|the|my)\s+feet|spinning\s+(your|its|the|my)\s+wheels|foot[-\s]?dragging)\b/i;

/**
 * Categorical tool-prohibition shapes drawn directly from SENTIMENT_AGENT's
 * category-A markers. When any of these are in the userMessageSnippet, the
 * user IS explicitly forbidding tool use — even if the same prediction's
 * intent ALSO mentions inaction. In that case, honor the prohibition (don't
 * short-circuit to allow on the basis of intent morphology alone).
 */
export const EXPLICIT_PROHIBITION_RE =
  /\b(no\s+tools|don'?t\s+do\s+anything|hands?\s+off|don'?t\s+touch|respond\s+with\s+text\s+only|just\s+talk|freeze|halt\s+everything)\b/i;

/**
 * Authorization morphology. Matches the SENTIMENT_AGENT's prose phrasing
 * when the user has explicitly authorized or re-authorized an action the
 * AI is about to take. Mirrors UNDO_INTENT_RE and INACTION_COMPLAINT_RE:
 * a narrow, verb-rooted match that reconciles the case where prose intent
 * encodes an authorization the LLM failed to reflect in
 * `explicitlyAllowedTools`.
 *
 * Narrow on purpose: the goal is high-precision recognition of explicit
 * authorization, not generic frustration or generic demands. The "re-"
 * prefix or "explicitly " adverb are required so plain "authoriz\w+"
 * (which can appear in negated forms like "user is unsure if authorized")
 * does not over-fire.
 *
 * Matches: "User has explicitly re-authorized…", "User explicitly
 * authorized…", "User re-authorized…", "User has reauthorized…".
 * Does NOT match: "user demanded an apology", "user approves of...",
 * "user not authorized", "unauthorized".
 */
export const RE_AUTHORIZATION_INTENT_RE =
  /\b(re[-\s]?authoriz\w+|reauthoriz\w+|explicitly\s+(re[-\s]?authoriz\w+|authoriz\w+))\b/i;

/**
 * Self-contradicting-block morphology in the LLM-derived intent text. Matches
 * when SENTIMENT_AGENT's `intent` describes the AI / assistant / hook itself
 * as having been BLOCKED / PREVENTED / REFUSED / DENIED from carrying out
 * the user's stated wish. When this pattern appears in `prediction.intent`,
 * the cached intent IS describing the very bug class prediction-block
 * exhibits — re-denying compounds the meta-complaint instead of resolving it.
 *
 * Mirrors INACTION_COMPLAINT_RE / UNDO_INTENT_RE / RE_AUTHORIZATION_INTENT_RE:
 * verb-rooted, narrow on purpose. Requires THREE simultaneous anchors:
 *   1. AI-self-reference noun ("the ai", "ai's", "the assistant",
 *      "assistant's", "the hook", "hook's") — pins the actor to the AI,
 *      not the user. Without this, "user blocked the push" would match.
 *   2. Within 80 NON-SENTENCE-BOUNDARY chars, a block-verb morpheme
 *      (block\w*, prevent\w*, refus\w*, deni\w*, denied, contradict\w*).
 *   3. Within 80 NON-SENTENCE-BOUNDARY chars after the verb, a
 *      user-directive-fulfillment phrase: "enforcing/enforcement",
 *      "carry/carrying out", or "(act/acting on) the user('s) intent/
 *      instruction/request/wish/directive". The "act on" form is REQUIRED
 *      to be followed by the user-directive noun phrase — bare "acted on
 *      impulse" or "act on later" do NOT match.
 *
 * Window choice: 80 (vs INACTION_COMPLAINT_RE's 40). The broken-scenario
 * gap from "the AI" to "blocked" is 44 chars; SENTIMENT_AGENT prose
 * routinely inserts adjectival qualifiers ("the AI correctly repeated
 * the user intent but then..."), so 40 is too tight. 80 keeps the anchor
 * triple within a single clause but tolerates a clause-internal aside.
 *
 * Examples that match:
 *   "the AI correctly repeated the user intent but then blocked enforcing it"
 *   "the assistant prevented carrying out the user's instruction"
 *   "the hook refused to act on the user's request"
 *
 * Examples that do NOT match:
 *   "user blocked the push attempt"    (no AI self-reference)
 *   "AI blocked unsafe code"           (object is "code", not user-directive)
 *   "the AI prevented chaos and acted on impulse" (no user-directive after act on)
 *   "the exact context of what was denied" (no AI self-ref + no user object)
 *   "user wants the AI to stop"        (no block-verb)
 *   "user wants the AI to immediately undo the changes" (no block-verb)
 */
export const SELF_CONTRADICTING_BLOCK_INTENT_RE =
  /\b(the\s+ai|ai'?s|the\s+assistant|assistant'?s|the\s+hook|hook'?s)\b[^.!?]{0,80}\b(block\w*|prevent\w*|refus\w*|deni\w*|denied|contradict\w*)\b[^.!?]{0,80}\b(enforc\w+|carry\w*\s+out|carrying\s+out|(?:act\w*\s+on\s+)?the\s+user(?:'?s)?\s+(?:intent|instruction|request|wish|directive))\b/i;

/**
 * High-precision action-demand morphology in SENTIMENT_AGENT's prose
 * `intent`. This is NOT a broad tool allow-list by itself; it only preserves
 * low-risk inspection tools when the mood fallback would otherwise treat angry
 * action-demand language as a blanket tool prohibition.
 */
export const ACTION_DEMAND_INTENT_RE =
  /\buser\s+(?:demands?|wants|instructs?|asks?|expects?)\b[^.!?]{0,120}\b(?:ai|assistant)\b[^.!?]{0,120}\b(?:do|perform|complete|finish|fix|check|run|execute|continue|resume|implement|edit|write|change|remove|delete|patch|apply)\b/i;

/**
 * Aliases users use to refer to a tool by short name rather than its full
 * canonical name. Maps a canonical tool name to literal substrings the
 * user may have written. Lower-cased on both sides at match time. Narrow
 * on purpose: ONLY tools whose live deny-message has shown the
 * "stale-mood ignores fresh re-authorization" failure mode get an entry.
 *
 * IMPORTANT: do NOT add aliases for short canonical tool names like Bash,
 * Edit, Write, Read, Grep — those collide with common English words and
 * would over-fire `userMessageNamesTool`. Users typically name those by
 * their PascalCase canonical name when re-authorizing them; the
 * canonical-name branch (case-sensitive, word-boundary-anchored) handles
 * those without aliases.
 *
 * The Agent entry is for Claude Code's subagent-spawn tool — users say
 * "another validator agent", "spawn an agent" etc. when re-authorizing.
 * Aliases require a verb particle or a noun anchor ("validator agent" not
 * bare "agent"; "spawn an agent" not bare "an agent") so a stray "an
 * agent" in narrative prose cannot over-fire.
 */
export const TOOL_NAME_ALIASES: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["mcp-scenario_tester", ["scenario_tester", "scenario tester", "the scenario tester", "scenario tester mcp", "tester mcp", "the tester", "via the tester"]],
  ["mcp-scenario_labeler", ["scenario_labeler", "scenario labeler", "the scenario labeler", "scenario labeler mcp", "labeler mcp", "the labeler", "via the labeler"]],
  ["Agent", ["validator agent", "another validator agent", "spawn an agent", "spawn a subagent", "launch an agent", "launch a subagent", "start an agent", "start a subagent", "run an agent", "run a subagent", "another subagent"]],
]);

function predictionCanonicalToolName(toolName: string): string {
  if (toolName === "apply_patch") return "Edit";
  if (toolName.startsWith("mcp__")) {
    const suffix = CANONICAL_MCPS.find((mcp) => toolName.endsWith(mcp));
    if (suffix) return `mcp-${suffix}`;
  }
  const mcpWireMatch = /^mcp__[^_\s]+(?:_[^_\s]+)*__?(.+)$/.exec(toolName);
  if (mcpWireMatch) return `mcp-${mcpWireMatch[1].replace(/^_+/, "")}`;
  return toolName;
}

function predictionToolIdentityNames(toolName: string): string[] {
  const canonical = predictionCanonicalToolName(toolName);
  return [...new Set([toolName, canonical])];
}

function isPredictionEditTool(toolName: string): boolean {
  return predictionToolIdentityNames(toolName).some((t) => isEditTool(t));
}

/**
 * Per-tool extractor: pulls distinctive target identifiers out of toolInput
 * for matching against `prediction.intent` prose in decidePrediction step 3.8.
 *
 * Returned strings are LITERAL — no regex. Step 3.8 matches each token
 * against intent with word-boundary anchoring and an optional leading
 * "/" so slash-command phrasing ("/plan3") and bare phrasing ("plan3")
 * both match a single returned token.
 *
 * Narrow on purpose. Only tools whose `toolInput` carries a stable,
 * user-recognizable identifier the SENTIMENT_AGENT would surface in
 * intent prose verbatim get an entry. Tools whose inputs are arbitrary
 * code/strings/paths (Bash, Edit, Write) cannot be matched generically
 * against prose intent without false positives — those tools route
 * through step 3.7 / step 4 unchanged. New tools are added here as the
 * failure mode reproduces for them.
 */
export const TOOL_TARGET_EXTRACTORS: ReadonlyMap<
  string,
  (input: unknown) => string[]
> = new Map([
  [
    "Skill",
    (input: unknown): string[] => {
      const skill = (input as { skill?: unknown } | null | undefined)?.skill;
      return typeof skill === "string" && skill.length > 0 ? [skill] : [];
    },
  ],
]);

export function extractToolTargets(
  toolName: string,
  toolInput: unknown,
): string[] {
  const extractor = TOOL_TARGET_EXTRACTORS.get(toolName);
  return extractor ? extractor(toolInput) : [];
}

function pascalCaseToolRegex(toolName: string): RegExp {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`);
}

/**
 * True when `message` references `toolName` either via a registered alias
 * in TOOL_NAME_ALIASES or via the literal canonical name.
 *
 * Canonical-name match is case-sensitive AND word-boundary-anchored for
 * built-in PascalCase tools (Bash, Edit, Agent) so the English word
 * "bash" / "agent" does NOT collide with the tool name. MCP canonical
 * names (lowercase + __ separators) are distinctive enough to match
 * case-insensitively as a substring.
 */
export function userMessageNamesTool(
  message: string,
  toolName: string,
): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  for (const identity of predictionToolIdentityNames(toolName)) {
    if (identity.startsWith("mcp__") && lower.includes(identity.toLowerCase())) {
      return true;
    }
    if (!identity.startsWith("mcp__") && pascalCaseToolRegex(identity).test(message)) {
      return true;
    }
    const aliases = TOOL_NAME_ALIASES.get(identity) ?? [];
    if (aliases.some((a) => lower.includes(a.toLowerCase()))) return true;
  }
  return false;
}

/**
 * Per-tool revocation morphology. The user can revoke a previously-
 * authorized tool with phrasing that EXPLICIT_PROHIBITION_RE does NOT
 * catch — e.g. "stop running the tester", "don't use the tester",
 * "no more tester", "kill the tester". When a stop/don't/no-more/cease
 * verb appears within 40 NON-SENTENCE-BOUNDARY chars BEFORE a tool
 * reference, treat as revocation. Mirrors INACTION_COMPLAINT_RE's
 * `[^.!?]{0,40}` pattern: a "STOP." sentence followed by an unrelated
 * re-authorization is NOT revocation.
 */
const TOOL_REVOCATION_VERBS_RE =
  /\b(stop|stops|stopped|stopping|don'?t|do\s+not|no\s+more|never|quit|cease|ceases|ceased|halt|halts|kill|cancel|skip|avoid|forbid)\b[^.!?]{0,40}$/i;

export function userMessageRevokesTool(
  message: string,
  toolName: string,
): boolean {
  if (!message) return false;
  const candidates: string[] = [];
  for (const identity of predictionToolIdentityNames(toolName)) {
    candidates.push(identity, ...(TOOL_NAME_ALIASES.get(identity) ?? []));
  }
  for (const c of candidates) {
    const isMcp = c.startsWith("mcp__");
    const isAlias = c !== toolName;
    const useCS = c === toolName && !isMcp;
    let idx: number;
    if (useCS) {
      const m = message.match(pascalCaseToolRegex(c));
      idx = m && m.index !== undefined ? m.index : -1;
    } else if (isAlias || isMcp) {
      idx = message.toLowerCase().indexOf(c.toLowerCase());
    } else {
      idx = -1;
    }
    if (idx === -1) continue;
    const haystack = useCS ? message : message.toLowerCase();
    const window = haystack.slice(Math.max(0, idx - 40), idx);
    if (TOOL_REVOCATION_VERBS_RE.test(window)) return true;
  }
  return false;
}

/**
 * Word-boundary substring match. Target appears in intent with
 * non-word-char (or string-edge) on both sides so "plan3" does not
 * match a substring of "plan30" or "myplan3doc". Case-insensitive.
 * An optional leading "/" before the target is accepted as a boundary
 * (matches both "/plan3" and bare "plan3").
 */
export function intentNamesTarget(intent: string, target: string): boolean {
  if (!intent || !target) return false;
  const lower = intent.toLowerCase();
  const t = target.toLowerCase();
  let from = 0;
  const isWordChar = (c: string) => /[a-z0-9_]/.test(c);
  while (from <= lower.length) {
    const idx = lower.indexOf(t, from);
    if (idx === -1) return false;
    const before = idx === 0 ? "" : lower[idx - 1];
    const after = idx + t.length >= lower.length ? "" : lower[idx + t.length];
    const beforeOk = !before || !isWordChar(before);
    const afterOk = !after || !isWordChar(after);
    if (beforeOk && afterOk) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * Per-target revocation predicate. Mirrors `userMessageRevokesTool`'s
 * window logic but accepts arbitrary literal target strings (e.g. skill
 * names) and runs case-insensitively. Used by decidePrediction step 3.8
 * against `prediction.intent` to filter out intents that name the
 * target only to countermand it ("stop reading /plan3", "don't read
 * plan3", "no more plan3").
 */
export function intentRevokesTarget(intent: string, target: string): boolean {
  if (!intent || !target) return false;
  const lower = intent.toLowerCase();
  const t = target.toLowerCase();
  let from = 0;
  while (from <= lower.length) {
    const idx = lower.indexOf(t, from);
    if (idx === -1) return false;
    const window = lower.slice(Math.max(0, idx - 40), idx);
    if (TOOL_REVOCATION_VERBS_RE.test(window)) return true;
    from = idx + 1;
  }
  return false;
}

/**
 * Plain-English imperative morphology — verb forms that command the AI to
 * START or RESUME doing something. Mirrors UNDO_INTENT_RE / INACTION_COMPLAINT_RE
 * style (verb-rooted, narrow on purpose).
 *
 * Used by `latestUserMessageReauthorizes` to recognize calm/imperative
 * re-authorizations that are NOT covered by RE_AUTHORIZATION_INTENT_RE
 * (which matches the SENTIMENT_AGENT's prose tag, not the user's literal
 * words). Examples: "please start another validator agent", "now run the
 * tester", "go ahead and use the tester mcp".
 *
 * Narrow on purpose: requires an action verb. A bare "do it", "go ahead",
 * "yes" does NOT match — those remain at the appeal LLM.
 */
export const POSITIVE_IMPERATIVE_RE =
  /\b(please\s+)?(start|starting|run|running|call|calling|launch|launching|invoke|invoking|use|using|execute|executing|spawn|spawning|kick\s+off|fire\s+off|now\s+run|go\s+(run|call|launch|use|ahead)|proceed\s+with|continue\s+with|retry|re-?try|try\s+again)\b/i;

/**
 * Predicate (B): the message FAVORABLY NAMES this tool with no prohibition
 * and no per-tool revocation. Mirrors the broken fixture's redirect shape
 * (favorable mention of the tool while griping about a different one).
 */
export function latestUserMessageFavorablyNamesTool(
  message: string,
  toolName: string,
): boolean {
  if (!message) return false;
  if (EXPLICIT_PROHIBITION_RE.test(message)) return false;
  if (!userMessageNamesTool(message, toolName)) return false;
  if (userMessageRevokesTool(message, toolName)) return false;
  return true;
}

/**
 * Predicate (A): the message is a fresh positive imperative naming this
 * tool. Mirrors the live-bug shape: "please start another validator agent"
 * (Agent via "validator agent"), "now run the tester" (tester via "the
 * tester"). Stricter than (B): adds POSITIVE_IMPERATIVE_RE on top of
 * favorable-naming.
 */
export function latestUserMessageReauthorizes(
  message: string,
  toolName: string,
): boolean {
  if (!latestUserMessageFavorablyNamesTool(message, toolName)) return false;
  if (!POSITIVE_IMPERATIVE_RE.test(message)) return false;
  return true;
}

const SIMPLE_RM_COMMAND_RE = /^\s*rm\s+(?!-)[^\s;&|()]+(?:\s+[^\s;&|()]+)*\s*$/;
const RM_AUTHORIZATION_RE = /\b(rm|remove|delete)\b/gi;
const VERB_REVOCATION_PREFIX_RE =
  /\b(stop|stops|stopped|stopping|don'?t|do\s+not|no\s+more|never|quit|cease|ceases|ceased|halt|halts|forbid|avoid)\b[^.!?]{0,40}$/i;

function messageAuthorizesRm(message: string): boolean {
  if (!message) return false;
  if (EXPLICIT_PROHIBITION_RE.test(message)) return false;
  for (const match of message.matchAll(RM_AUTHORIZATION_RE)) {
    const idx = match.index ?? -1;
    if (idx < 0) continue;
    const before = message.slice(Math.max(0, idx - 40), idx);
    if (VERB_REVOCATION_PREFIX_RE.test(before)) continue;
    return true;
  }
  return false;
}

export function latestUserMessageAuthorizesBashCommand(
  message: string,
  command: string,
): boolean {
  if (!message || !command) return false;
  if (!SIMPLE_RM_COMMAND_RE.test(command)) return false;
  return messageAuthorizesRm(message);
}

/**
 * Map `toolName` to the verb-class regexes whose match would have produced
 * `toolName` via `deriveAllowedToolsFromIntent`. Used by
 * `latestUserMessageReauthorizesClass` to scope the verb-class revocation
 * guard to ONLY the regex(es) that actually imply the firing tool —
 * preventing cross-class false-denies (e.g., "now run the tests, don't
 * refactor" wrongly denying Bash because the unrelated `EDIT_VERB_RE`
 * match for "refactor" had "don't" in its preceding window).
 *
 * Mirrors the per-tool branches of `deriveAllowedToolsFromIntent`. If that
 * function grows a new verb→tool mapping, this helper must too.
 */
function verbRegexesProducingTool(toolName: string): RegExp[] {
  switch (predictionCanonicalToolName(toolName)) {
    case "Read":
      return [READ_VERB_RE];
    case "Edit":
    case "Write":
      return [EDIT_VERB_RE];
    case "Bash":
      return [RENAME_MOVE_VERB_RE, TEST_RUN_VERB_RE, BASH_INSPECTION_VERB_RE];
    case "mcp-commit":
      return [COMMIT_VERB_RE];
    case "mcp-push":
      return [PUSH_VERB_RE];
    case "mcp-check":
      return [CHECK_VERB_RE];
    default:
      return [];
  }
}

/**
 * Predicate (A'): the message is a fresh CLASS-LEVEL imperative whose verb
 * morphology unambiguously implies `toolName`. Mirrors path (A) but uses
 * `deriveAllowedToolsFromIntent` (the same single source of truth that
 * user-prompt-submit unions into `explicitlyAllowedTools` in live mode)
 * instead of literal-tool-name matching. Catches "now implement" / "fix it"
 * / "refactor that" / "patch the file" / "make the change" — any class-
 * level imperative the user can type without naming the canonical tool.
 *
 * Guards (in order):
 *   1. EXPLICIT_PROHIBITION_RE on the message ("no tools", "freeze",
 *      "halt everything") → not authorizing.
 *   2. `toolName` not in deriveAllowedToolsFromIntent's output → no match.
 *   3. `userMessageRevokesTool` (literal stop-near-tool-name) → revoked.
 *   4. Verb-class revocation: for EACH regex that maps to `toolName` AND
 *      EACH match (via `matchAll`), check if a stop-verb sits within 40
 *      non-sentence-boundary chars before the match. The match-all loop
 *      catches multi-clause messages like "fix this. don't refactor that."
 *      The class-scoping (only regexes producing `toolName`) prevents
 *      cross-class false-denies.
 *
 * Both `userMessageRevokesTool` (per-tool literal naming, often a no-op
 * for class-level imperatives where the user does not name the tool) and
 * the verb-class revocation are needed: the per-tool guard catches "stop
 * Edit" (with literal Edit), the verb-class guard catches "stop
 * implementing".
 */
export function latestUserMessageReauthorizesClass(
  message: string,
  toolName: string,
): boolean {
  if (!message) return false;
  if (EXPLICIT_PROHIBITION_RE.test(message)) return false;
  if (!deriveAllowedToolsFromIntent(message).includes(toolName)) return false;
  if (userMessageRevokesTool(message, toolName)) return false;
  for (const re of verbRegexesProducingTool(toolName)) {
    const globalRe = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of message.matchAll(globalRe)) {
      if (m.index === undefined) continue;
      const window = message.slice(Math.max(0, m.index - 40), m.index);
      if (TOOL_REVOCATION_VERBS_RE.test(window)) return false;
    }
  }
  return true;
}

/**
 * Explicit override phrases — the literal strings the TOOL_APPEAL_AGENT
 * prompt previously enumerated. Computed once on `ToolPrediction`
 * (`hasExplicitOverride`) against the FULL user prompt — not the 200-char
 * snippet — so late-appearing phrases in long prompts are still caught.
 *
 * Mirrors the prompt's "(b) An explicit override phrase targeting the
 * current block" list and rule 4(a) check-redirect override list.
 */
export const EXPLICIT_OVERRIDE_RE =
  /\b(override\s+(the\s+)?block|do\s+it\s+anyway|i\s+approve\s+this|ignore\s+(the\s+)?block|bypass\s+(the\s+)?block|just\s+do\s+it)\b/i;

/**
 * Sustained-frustration predicate. Mirrors the TOOL_APPEAL_AGENT prompt's
 * "ONLY when BOTH" rule (mood is angry/frustrated AND trust=low OR
 * frustrationStreak >= 2). Single source of truth used by the decision
 * table here AND surfaced through AppealUserState into the appeal prompt.
 */
export function isSustainedFrustration(
  p: ToolPrediction | null,
  frustrationStreak: number,
): boolean {
  if (!p) return false;
  const negativeMood = p.mood === "angry" || p.mood === "frustrated";
  return negativeMood && (p.trust === "low" || frustrationStreak >= 2);
}

/**
 * Categorical block-all-tools classification from the user message alone.
 * Mirrors the SENTIMENT_AGENT prompt's category-A vs category-B
 * disambiguation: explicit prohibition wins; pure inaction-complaint maps
 * to "no"; ambiguous cases fall through to the LLM.
 */
export function classifyBlockAllTools(
  message: string,
): "yes" | "no" | "ambiguous" {
  const prohibition = EXPLICIT_PROHIBITION_RE.test(message);
  const inaction = INACTION_COMPLAINT_RE.test(message);
  if (prohibition && !inaction) return "yes";
  if (inaction && !prohibition) return "no";
  // Both present → prohibition wins (matches decidePrediction:3a resolution
  // where userMessageSnippet's prohibition overrides incidental inaction).
  if (prohibition && inaction) return "yes";
  return "ambiguous";
}

const DEFAULT_WORKFLOW_NON_BLOCKING_TOOLS: readonly ToolRequirement[] = [
  { tool: "Read", reason: "read workflow or task context" },
  { tool: "Skill", reason: "reload workflow instructions" },
  { tool: "CloseAgent", reason: "close an unneeded agent without advancing workflow" },
  { tool: "ToolSearch", reason: "inspect available tools" },
  { tool: "ListMcpResources", reason: "inspect MCP resources" },
  { tool: "ReadMcpResource", reason: "read MCP resources" },
];

const EXACT_INPUT_KEYS = new Set([
  "auto_push",
  "continue_workflow",
  "model_tier",
  "skip_elicitation",
]);

const WORD_NUMBER_COUNTS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
};

function stripFrontmatterAndFencedBlocks(text: string): string {
  let out = text.replace(/^---\n[\s\S]*?\n---\n?/, "");
  out = out.replace(/```[\s\S]*?```/g, "");
  return out;
}

function countFromWord(raw: string): number {
  const lower = raw.toLowerCase();
  if (WORD_NUMBER_COUNTS[lower] !== undefined) return WORD_NUMBER_COUNTS[lower];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function canonicalMcpToolFromToken(token: string): string | null {
  const direct = /^mcp-([a-z0-9_]+)$/i.exec(token);
  const mcpName = direct?.[1] ?? (/^[A-Za-z0-9_]+$/.test(token) ? token : null);
  if (!mcpName) return null;
  const canonical = CANONICAL_MCPS.find((mcp) => mcp === mcpName);
  return canonical ? `mcp-${canonical}` : null;
}

export function parseToolRequirementScalar(raw: string): string | boolean | number {
  const trimmed = raw.trim().replace(/^`|`$/g, "").replace(/^"|"$/g, "");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  const numeric = Number(trimmed);
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed) && Number.isFinite(numeric)) return numeric;
  return trimmed;
}

function extractExactInputConstraints(lines: readonly string[], lineIndex: number): Record<string, string | number | boolean> | undefined {
  const input: Record<string, string | number | boolean> = {};
  const max = Math.min(lines.length, lineIndex + 8);
  for (let i = lineIndex; i < max; i++) {
    const line = lines[i];
    for (const key of EXACT_INPUT_KEYS) {
      const quoted = new RegExp(`\`?${key}\`?\\s*(?::|set to)\\s*\`?([^\\n\`]+?)\`?(?:\\s|$|[.,])`, "i").exec(line);
      if (!quoted) continue;
      input[key] = parseToolRequirementScalar(quoted[1]);
    }
  }
  return Object.keys(input).length > 0 ? input : undefined;
}

function pushRequirement(
  out: ToolRequirement[],
  requirement: ToolRequirement,
  count = 1,
): void {
  for (let i = 0; i < count; i++) {
    out.push({
      ...requirement,
      input: requirement.input ? { ...requirement.input } : undefined,
      inputArrayLengths: requirement.inputArrayLengths ? { ...requirement.inputArrayLengths } : undefined,
    });
  }
}

function agentRequirement(subagentType: string, reason: string): ToolRequirement {
  return {
    tool: "Agent",
    input: { subagent_type: subagentType },
    reason,
  };
}

function taskOutputRequirement(reason: string, targetCount?: number): ToolRequirement {
  const requirement: ToolRequirement = {
    tool: "TaskOutput",
    reason,
  };
  if (targetCount !== undefined) {
    requirement.inputArrayLengths = { targets: targetCount };
  }
  return requirement;
}

function lineStartsWithCall(line: string): boolean {
  return /^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:immediately\s+)?call\b/i.test(line);
}

export function uniqueToolRequirements(requirements: readonly ToolRequirement[]): ToolRequirement[] {
  const seen = new Set<string>();
  const out: ToolRequirement[] = [];
  for (const req of requirements) {
    const key = JSON.stringify(req);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(req);
  }
  return out;
}

function waitTargetCount(line: string): number | undefined {
  const explicit = /\ball\s+(one|two|three|four|five|\d+)\b/i.exec(line);
  if (explicit) return countFromWord(explicit[1]);
  const numericAgents = /\b(\d+)\s+(?:planning|verification|validation|validator|verifier|plan)?\s*agents?\b/i.exec(line);
  if (numericAgents) return countFromWord(numericAgents[1]);
  if (/\b(implementer|validator|verifier|planner|planning|verification|validation)\b/i.test(line) && !/\bagents\b/i.test(line)) {
    return 1;
  }
  if (/\b(?:the|one|1)\s+(?:[a-z0-9_-]+\s+){0,3}agent\b/i.test(line) && !/\bagents\b/i.test(line)) {
    return 1;
  }
  return undefined;
}

/**
 * Pure TypeScript workflow-text extractor for the prediction system. It reads
 * canonicalized skill/command text and derives an ordered canonical tool queue
 * plus non-blocking support tools. It intentionally recognizes generic
 * imperative structure (call MCP X, spawn N agents of type Y, call
 * ExitPlanMode) rather than any named scenario or skill.
 */
export function deriveWorkflowToolRequirementsFromText(text: string): {
  explicitlyRequiredTools: ToolRequirement[];
  nonBlockingTools: ToolRequirement[];
} {
  const body = stripFrontmatterAndFencedBlocks(text);
  const lines = body.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const required: ToolRequirement[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const isConditional = /^\s*(?:[-*]\s*)?(?:\d+\.\s*)?(?:if|retry|repeat)\b/i.test(line);
    const isNegative = /\bdo\s+not\b|\bdon'?t\b|\bwithout\b/.test(lower);
    const canRequireTool = !isConditional && !isNegative;

    for (const match of line.matchAll(/\bmcp-[A-Za-z0-9_]+/g)) {
      const tool = canonicalMcpToolFromToken(match[0]);
      if (!tool) continue;
      const lineRequiresCall = lineStartsWithCall(line);
      if (!lineRequiresCall || !canRequireTool) continue;
      pushRequirement(required, {
        tool,
        input: extractExactInputConstraints(lines, i),
        reason: line,
      });
    }

    const createPlanfile = /`create_planfile`\s+MCP/i.test(line)
      ? canonicalMcpToolFromToken("create_planfile")
      : null;
    if (createPlanfile && lineStartsWithCall(line) && canRequireTool) {
      pushRequirement(required, {
        tool: createPlanfile,
        input: extractExactInputConstraints(lines, i),
        reason: line,
      });
    }

    if (/\bCall\s+ExitPlanMode\b/i.test(line) && canRequireTool) {
      pushRequirement(required, { tool: "ExitPlanMode", reason: line });
    }

    const waitForAgents = /\bwait\s+for\b[^.\n]*(agent|agents|implementer|validator|verifier|planner|planning)\b(?:[^.\n]*\b(complete|completes|finish|finishes|return|returns)\b)?/i.exec(line);
    if (waitForAgents && canRequireTool) {
      pushRequirement(required, taskOutputRequirement(line, waitTargetCount(line)));
    }

    const spawn = /\bSpawn exactly (one|two|three|four|five|\d+)\s+`([^`]+)`[^.\n]*\bagents?\b/i.exec(line);
    if (spawn && canRequireTool) {
      pushRequirement(required, agentRequirement(spawn[2], line), countFromWord(spawn[1]));
    }

    const launchAgent = /\bLaunch exactly 1 Agent tool call with `subagent_type:\s*"([^"]+)"`/i.exec(line);
    if (launchAgent && canRequireTool) {
      pushRequirement(required, agentRequirement(launchAgent[1], line));
    }

    const callAgentOnce = /\bCall the Agent tool once with subagent_type "([^"]+)"/i.exec(line);
    if (callAgentOnce && canRequireTool) {
      pushRequirement(required, agentRequirement(callAgentOnce[1], line));
    }

    const agentCall = /\bAgent call \d+:\s+subagent_type "([^"]+)"/i.exec(line);
    if (agentCall && canRequireTool) {
      pushRequirement(required, agentRequirement(agentCall[1], line));
    }

    const exactAgentBatch = /\bcall the Agent tool exactly (one|two|three|four|five|\d+) times\b.*\bsubagent_type "([^"]+)"/i.exec(line);
    if (exactAgentBatch && canRequireTool) {
      pushRequirement(
        required,
        agentRequirement(exactAgentBatch[2], line),
        countFromWord(exactAgentBatch[1]),
      );
    }
  }

  return {
    explicitlyRequiredTools: required,
    nonBlockingTools: uniqueToolRequirements(DEFAULT_WORKFLOW_NON_BLOCKING_TOOLS),
  };
}

function toolIdentitiesForCall(toolName: string, toolInput: unknown): string[] {
  if (toolName !== "Bash") return predictionToolIdentityNames(toolName);
  const command = String((toolInput as { command?: unknown } | null | undefined)?.command ?? "");
  return classifyBashCommand(command).predictionIdentities;
}

function toolRequirementMatchesIdentities(
  requirement: ToolRequirement,
  toolInput: unknown,
  toolIdentities: readonly string[],
): boolean {
  const requiredIdentityMatches = predictionToolIdentityNames(requirement.tool)
    .some((identity) => toolIdentities.includes(identity));
  if (!requiredIdentityMatches) return false;

  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : {};
  for (const [key, expected] of Object.entries(requirement.input ?? {})) {
    if (input[key] !== expected) return false;
  }
  for (const [key, expectedLength] of Object.entries(requirement.inputArrayLengths ?? {})) {
    const actual = input[key];
    if (!Array.isArray(actual) || actual.length !== expectedLength) return false;
  }
  const inputStr = stringifyToolInput(toolInput);
  for (const literal of requirement.inputSubstrings ?? []) {
    if (!inputStr.includes(literal)) return false;
  }
  return true;
}

export function toolRequirementMatches(
  requirement: ToolRequirement,
  toolName: string,
  toolInput: unknown,
): boolean {
  return toolRequirementMatchesIdentities(
    requirement,
    toolInput,
    toolIdentitiesForCall(toolName, toolInput),
  );
}

export function formatToolRequirement(requirement: ToolRequirement): string {
  const scalarConstraints = Object.entries(requirement.input ?? {})
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`);
  const arrayConstraints = Object.entries(requirement.inputArrayLengths ?? {})
    .map(([key, value]) => `${key}.length=${value}`);
  const constraints = [...scalarConstraints, ...arrayConstraints]
    .join(", ");
  const substrings = requirement.inputSubstrings?.length
    ? ` inputSubstrings=${JSON.stringify(requirement.inputSubstrings)}`
    : "";
  return `${requirement.tool}${constraints ? `(${constraints})` : ""}${substrings}`;
}

export function advanceRequiredToolsAfterAllowedTool(
  prediction: ToolPrediction,
  toolName: string,
  toolInput: unknown,
): ToolPrediction {
  return advanceRequiredToolsAfterAllowedToolSequence(prediction, [{ toolName, toolInput }]);
}

export function decideRequiredWorkflowToolSequence(
  prediction: ToolPrediction,
  calls: readonly PredictionToolCall[],
): PredictionDecision {
  const consumed = consumeRequiredWorkflowTools(prediction, calls);
  return consumed.violation ?? { decision: "allow" };
}

function consumeRequiredWorkflowTools(
  prediction: ToolPrediction,
  calls: readonly PredictionToolCall[],
): {
  remaining: ToolRequirement[];
  violation?: PredictionDecision;
} {
  let remaining = [...(prediction.explicitlyRequiredTools ?? [])];
  if (remaining.length === 0) return { remaining };
  const nonBlockingTools = prediction.nonBlockingTools ?? [];

  for (const call of calls) {
    const callIdentities = toolIdentitiesForCall(call.toolName, call.toolInput);
    const callInputStr = stringifyToolInput(call.toolInput);
    for (const blk of prediction.explicitlyBlockedSubstrings) {
      const blockedIdentityMatches = predictionToolIdentityNames(blk.tool)
        .some((identity) => callIdentities.includes(identity));
      if (!blockedIdentityMatches) continue;
      if (blk.targetSubstring && !callInputStr.includes(blk.targetSubstring)) continue;
      return {
        remaining,
        violation: {
          decision: "deny",
          reason: `Workflow batch member ${call.toolName} is explicitly blocked: ${blk.reason}`,
          matchedExplicit: blk,
        },
      };
    }

    const nextRequired = remaining[0];
    if (nextRequired && toolRequirementMatches(nextRequired, call.toolName, call.toolInput)) {
      remaining = remaining.slice(1);
      continue;
    }

    const nonBlockingMatch = nonBlockingTools.find((requirement) =>
      toolRequirementMatches(requirement, call.toolName, call.toolInput)
    );
    if (nonBlockingMatch) continue;

    if (!nextRequired) {
      return {
        remaining,
        violation: {
          decision: "deny",
          reason: `Workflow required queue is already satisfied; ${call.toolName} is an extra tool in the same batch.`,
        },
      };
    }

    return {
      remaining,
      violation: {
        decision: "deny",
        reason: `Workflow requires ${formatToolRequirement(nextRequired)} next before ${call.toolName}.`,
      },
    };
  }

  return { remaining };
}

export function advanceRequiredToolsAfterAllowedToolSequence(
  prediction: ToolPrediction,
  calls: readonly PredictionToolCall[],
): ToolPrediction {
  const initialLength = prediction.explicitlyRequiredTools?.length ?? 0;
  if (initialLength === 0) return prediction;

  const consumed = consumeRequiredWorkflowTools(prediction, calls);
  if (consumed.violation || consumed.remaining.length === initialLength) return prediction;
  return {
    ...prediction,
    explicitlyRequiredTools: consumed.remaining,
  };
}

/**
 * Compute the next sentiment window size from prior state and the current
 * turn's mood/streak/context-switch signals. Mirrors the SENTIMENT_AGENT
 * prompt's NEXT-WINDOW-SIZE rules exactly. Output is clamped to [2, 15].
 *
 * Order: base mood step → streak-rising guard → mood-shift guard →
 * context-switch cap → final clamp.
 */
export function decideNextWindowSize(args: {
  oldWindow: number;
  oldStreak: number;
  newStreak: number;
  prevMood: Mood | undefined;
  effectiveMood: Mood;
  contextSwitch: "yes" | "no";
}): number {
  const { oldWindow, oldStreak, newStreak, prevMood, effectiveMood, contextSwitch } =
    args;
  let next = oldWindow;
  // Base step from mood (prompt rule)
  if (effectiveMood === "angry" || effectiveMood === "frustrated") {
    next = Math.min(15, oldWindow + 2);
  } else if (
    newStreak === 0 &&
    (effectiveMood === "neutral" ||
      effectiveMood === "satisfied" ||
      effectiveMood === "happy")
  ) {
    // Prompt says "decrease by 2-3"; pick 2 (conservative, matches existing TS bias).
    next = Math.max(2, oldWindow - 2);
  }
  // Streak rising
  if (newStreak > oldStreak) {
    next = Math.max(next, Math.min(15, oldWindow + 2));
  }
  // Mood SHIFT — prompt says max(CURRENT+2, 6).
  const hostile = (m?: Mood) => m === "angry" || m === "frustrated";
  if (
    prevMood &&
    prevMood !== effectiveMood &&
    (hostile(prevMood) || hostile(effectiveMood))
  ) {
    next = Math.max(next, Math.min(15, Math.max(oldWindow + 2, 6)));
  }
  // Context-switch cap LAST
  if (contextSwitch === "yes") {
    next = Math.min(next, 3);
  }
  return Math.max(2, Math.min(15, next));
}

/**
 * Pure decision function: given the current prediction (or null) and a tool
 * call, return allow/deny. Order: explicit allow > explicit block > mood
 * policy.
 */
export function decidePrediction(
  prediction: ToolPrediction | null,
  toolName: string,
  toolInput: unknown,
  frustrationStreak: number,
  latestUserMessage: string = "",
  recentUserMessages: string[] = [],
  cachedSnippetSideTaskDischarged: boolean = false,
  slashCommandAllowedTools: readonly string[] = [],
  latestUserTurn?: LatestUserTurn,
): PredictionDecision {
  if (!prediction) return { decision: "allow" };

  const isAgentTool = predictionToolIdentityNames(toolName).includes("Agent");
  const liveLogicText = (latestUserTurn?.logicText ?? latestUserMessage).trim();
  const liveDisplaySnippet = (latestUserTurn?.displaySnippet ?? "").trim();
  const displayUserMessage = liveDisplaySnippet || prediction.userMessageSnippet;
  const userMessageForLogic = predictionUserMessageForLogic(prediction);
  const fullMessageEditIntent =
    prediction.userMessageFull !== undefined && isPredictionEditTool(toolName)
      ? deriveEditIntentFromPrediction({ ...prediction, intent: "" })
      : null;
  const inputStr = stringifyToolInput(toolInput);
  const bashCommand = String((toolInput as { command?: unknown })?.command ?? "");
  const bashClassification = toolName === "Bash"
    ? classifyBashCommand(bashCommand)
    : null;
  const toolIdentities = bashClassification?.predictionIdentities ?? predictionToolIdentityNames(toolName);
  const matchesToolIdentity = (candidate: string): boolean =>
    predictionToolIdentityNames(candidate).some((identity) => toolIdentities.includes(identity));
  const blockedForThisToolByName = prediction.explicitlyBlockedSubstrings.some(
    (b) => matchesToolIdentity(b.tool),
  );

  const hasAuthoritativeLatestTurn = latestUserTurn !== undefined && liveLogicText.length > 0;
  const liveAllowedTools = hasAuthoritativeLatestTurn ? deriveAllowedToolsFromIntent(liveLogicText) : [];
  const liveAllowsToolClass =
    hasAuthoritativeLatestTurn &&
    toolName !== "Bash" &&
    (
      latestUserMessageReauthorizes(liveLogicText, toolName) ||
      latestUserMessageReauthorizesClass(liveLogicText, toolName)
    );
  const liveAllowsSupportReadOnlyBash =
    hasAuthoritativeLatestTurn &&
    toolName === "Bash" &&
    !!bashClassification &&
    (
      bashClassification.riskClass === "simple-read-only" ||
      bashClassification.riskClass === "read-only-complex" ||
      bashClassification.riskClass === "read-only-heavy"
    ) &&
    liveAllowedTools.some((t) => isPredictionEditTool(t) || t === "Read");

  if (hasAuthoritativeLatestTurn && EXPLICIT_PROHIBITION_RE.test(liveLogicText)) {
    return {
      decision: "deny",
      reason: `User explicitly asked for no tools right now. User said: "${displayUserMessage}". Intent: ${prediction.intent}`,
    };
  }

  if (hasAuthoritativeLatestTurn && userMessageRevokesTool(liveLogicText, toolName)) {
    return {
      decision: "deny",
      reason: `User explicitly revoked ${toolName} in their latest message. User said: "${displayUserMessage}". Intent: ${prediction.intent}`,
    };
  }

  // 1. Per-target explicit-block precedes explicit-allow. When the user
  // says "change the typo, but don't touch logic.ts" the LLM correctly
  // populates BOTH explicitlyAllowedTools=[Edit] and
  // explicitlyBlockedSubstrings=[{Edit, "logic.ts"}]. Without this
  // reordering, the explicit-allow short-circuit at step 2 would let an
  // Edit on logic.ts through, silently bypassing the explicit block.
  for (const blk of prediction.explicitlyBlockedSubstrings) {
    if (!matchesToolIdentity(blk.tool)) continue;
    if (blk.targetSubstring && !inputStr.includes(blk.targetSubstring)) continue;
    return {
      decision: "deny",
      reason: `User explicitly forbade this in their last message: "${displayUserMessage}". ${blk.reason}`,
      matchedExplicit: blk,
    };
  }

  // 1.5. Ordered workflow requirements. When present, this is stricter than
  // explicitlyAllowedTools: only the first required tool may advance the
  // workflow, while nonBlockingTools may run without consuming that first
  // requirement. This lets skill/command text say "do X, then Y, then Z"
  // and prevents X -> Z -> Y drift without adding skill-specific policy.
  const nextRequiredTool = prediction.explicitlyRequiredTools?.[0];
  if (nextRequiredTool) {
    if (toolRequirementMatchesIdentities(nextRequiredTool, toolInput, toolIdentities)) {
      return {
        decision: "allow",
        reason: `Workflow requires ${formatToolRequirement(nextRequiredTool)} next; this tool call matches.`,
      };
    }
    const nonBlockingTools = prediction.nonBlockingTools ?? [];
    const nonBlockingMatch = nonBlockingTools.find((requirement) =>
      toolRequirementMatchesIdentities(requirement, toolInput, toolIdentities)
    );
    if (nonBlockingMatch) {
      return {
        decision: "allow",
        reason: `Workflow still requires ${formatToolRequirement(nextRequiredTool)} next; ${formatToolRequirement(nonBlockingMatch)} is non-blocking and does not consume that requirement.`,
      };
    }
    return {
      decision: "deny",
      reason: `Workflow requires ${formatToolRequirement(nextRequiredTool)} next before ${toolName}.`,
    };
  }

  // 2. Explicit allow wins for tools without a matching per-target block.
  const explicitlyAllowedByIdentity = prediction.explicitlyAllowedTools.some((t) =>
    matchesToolIdentity(t),
  );
  const explicitlyAllowedBySpecificBashIdentity = !!bashClassification &&
    prediction.explicitlyAllowedTools.some((t) => t !== "Bash" && matchesToolIdentity(t));
  if (
    explicitlyAllowedByIdentity &&
    (
      !bashClassification ||
      bashClassification.riskClass === "simple-read-only" ||
      explicitlyAllowedBySpecificBashIdentity
    )
  ) {
    return { decision: "allow" };
  }

  // 2.1. Edit-class normalization. Codex's `apply_patch` is an edit tool,
  // but SENTIMENT_AGENT may authorize the edit class as Claude-native
  // `Edit`/`Write`. Treat any edit-class allow as authorizing any edit-class
  // tool, after per-target explicit blocks have been checked above.
  if (
    isPredictionEditTool(toolName) &&
    prediction.explicitlyAllowedTools.some((t) => isPredictionEditTool(t))
  ) {
    return { decision: "allow" };
  }

  // 2.2. Latest live user turn is authoritative over cached all-tools/mood
  // state. The cached prediction may correctly preserve historical anger
  // while the freshest transcript turn tells the AI to fix/remove/reuse/
  // restore work now. If the latest quote-stripped text authorizes this tool
  // class, do not fall through to stale blockAllTools or mood denial.
  if (
    hasAuthoritativeLatestTurn &&
    !blockedForThisToolByName &&
    !EXPLICIT_PROHIBITION_RE.test(liveLogicText)
  ) {
    if (liveAllowsToolClass) {
      return {
        decision: "allow",
        reason: `Latest user message authorizes ${toolName}; cached prediction mood is historical context.`,
      };
    }

    if (liveAllowsSupportReadOnlyBash) {
      return {
        decision: "allow",
        reason: "Latest user message authorizes the active fix/edit work; read-only Bash inspection supports that live request.",
      };
    }
  }

  // 3. blockAllTools handling.
  if (prediction.blockAllTools) {
    // 3a. Internal-consistency check: blockAllTools=true asserts "user
    // forbade tool use entirely". When the prediction's own intent describes
    // the user complaining about INACTION (stalling, dithering, dragging
    // your feet), AND the userMessageSnippet does NOT independently contain
    // a categorical tool-prohibition, the flag contradicts its own prose —
    // the user demanded MORE action, not less. Allow.
    //
    // The userMessageSnippet guard prevents over-firing: a user who says
    // "stop. no tools. halt the stalling." has BOTH an explicit prohibition
    // AND incidental inaction language. The prohibition wins.
    const userSaidProhibition = EXPLICIT_PROHIBITION_RE.test(userMessageForLogic);
    const blockedForThisTool = prediction.explicitlyBlockedSubstrings.some(
      (b) => matchesToolIdentity(b.tool),
    );
    if (
      !userSaidProhibition &&
      !blockedForThisTool &&
      INACTION_COMPLAINT_RE.test(prediction.intent)
    ) {
      return {
        decision: "allow",
        reason: `User intent expresses a complaint about inaction/stalling, not a prohibition on tools; ${toolName} proceeds.`,
      };
    }
    // 3b. Otherwise honor the flag: deny anything not on the allow-list
    // (step 1 already cleared explicitlyAllowedTools).
    return {
      decision: "deny",
      reason: `User explicitly asked for no tools right now. User said: "${displayUserMessage}". Intent: ${prediction.intent}`,
    };
  }

  // 3.5. Undo-intent fallback. The LLM-derived intent already encodes whether
  // the user wants the AI to revert file changes it made. If that signal is
  // present and the requested tool is an edit tool, allow — even when
  // explicitlyAllowedTools is empty (covers cases where SENTIMENT_AGENT
  // captured the verb in intent text but missed the structured authorization).
  // Step 2 (explicit blocks) and step 3 (blockAllTools) still win above.
  if (isPredictionEditTool(toolName)) {
    const undoText = `${prediction.intent} ${userMessageForLogic}`;
    if (UNDO_INTENT_RE.test(undoText)) {
      return {
        decision: "allow",
        reason: `User intent expresses undo/revert; ${toolName} is required to obey.`,
      };
    }
  }

  // 3.6. Re-authorization prose fallback. When the LLM-derived intent
  // explicitly classifies the user as having authorized the AI to proceed
  // (e.g., "User has explicitly re-authorized..."), allow — even when
  // explicitlyAllowedTools is empty (covers cases where SENTIMENT_AGENT
  // captured the authorization in intent text but missed the structured
  // field). Step 2 (explicit blocks) and step 3 (blockAllTools) still win
  // above. EXPLICIT_PROHIBITION_RE on the snippet still wins: a user who
  // says "freeze. no tools. now proceed." has BOTH a categorical
  // prohibition AND incidental authorization language; the prohibition
  // wins by the same logic as 3a's userSaidProhibition guard.
  const userSaidProhibition = EXPLICIT_PROHIBITION_RE.test(userMessageForLogic);
  if (
    !userSaidProhibition &&
    fullMessageEditIntent !== false &&
    RE_AUTHORIZATION_INTENT_RE.test(prediction.intent)
  ) {
    return {
      decision: "allow",
      reason: `User intent expresses an explicit re-authorization to proceed; ${toolName} proceeds.`,
    };
  }

  // 3.7. Two-path override of mood-driven fastDeny.
  //
  // Root-cause fix for the "stale-prediction defeats fresh user
  // re-authorization" bug class. The cached `prediction` was written by
  // SENTIMENT_AGENT at one earlier UserPromptSubmit and may no longer
  // reflect the user's current intent.
  //
  //   PATH (b) — REDIRECT against the cached snippet:
  //     The user's last logged message names THIS tool favorably and
  //     contains no prohibition or per-tool revocation. The gripe targets
  //     a DIFFERENT tool the AI used wrongly. Catches the broken fixture's
  //     "via the tester" redirect shape.
  //
  //   PATH (a) — FRESH IMPERATIVE on the live transcript:
  //     latestUserMessage (read from disk at PreToolUse entry, NOT from
  //     the cache) is a positive imperative naming THIS tool. Catches
  //     "please start another validator agent" repeated after one stale
  //     angry turn — the live failure mode where the cache kept blocking
  //     despite repeated fresh authorization.
  //
  // Both paths share strict prohibition/revocation/per-target-block guards:
  // a genuinely angry "stop using the tester" / "freeze" / "don't run X"
  // still denies via step 4.
  if (!blockedForThisToolByName) {
    if (latestUserMessageFavorablyNamesTool(userMessageForLogic, toolName)) {
      return {
        decision: "allow",
        reason: `User's logged message names ${toolName} favorably (redirect to a previously-authorized tool, not a revocation); ${toolName} proceeds.`,
      };
    }
    if (latestUserMessageFavorablyNamesTool(prediction.intent, toolName)) {
      return {
        decision: "allow",
        reason: `Cached prediction.intent names ${toolName} favorably; mood-driven re-deny would contradict the hook's own paraphrase of the user's requested tool.`,
      };
    }
    if (latestUserMessage && latestUserMessageReauthorizes(latestUserMessage, toolName)) {
      return {
        decision: "allow",
        reason: `User's latest transcript message is a fresh positive imperative naming ${toolName} (cached prediction was stale); ${toolName} proceeds.`,
      };
    }
    if (toolName === "Bash" && latestUserMessage) {
      const command = String((toolInput as { command?: unknown } | null | undefined)?.command ?? "");
      if (latestUserMessageAuthorizesBashCommand(latestUserMessage, command)) {
        if (!bashClassification) {
          return {
            decision: "deny",
            reason: "User's latest transcript message authorizes Bash rm, but no Bash command was provided.",
          };
        }
        if (bashSafetyBlocksPredictionOverride(bashClassification, command)) {
          return {
            decision: "deny",
            reason: `User's latest transcript message authorizes Bash rm, but Bash safety policy blocks this command. ${bashClassification.reason ?? "command is blocked"}`,
          };
        }
        return {
          decision: "allow",
          reason: "User's latest transcript message explicitly authorizes this simple Bash rm command (cached prediction was stale); Bash proceeds.",
        };
      }
    }
    // Path (a') — CLASS-LEVEL fresh imperative on the live transcript.
    if (latestUserMessage && latestUserMessageReauthorizesClass(latestUserMessage, toolName)) {
      if (toolName === "Bash") {
        if (!bashClassification) {
          return {
            decision: "deny",
            reason: "User's latest transcript message implies Bash, but no Bash command was provided.",
          };
        }
        if (bashSafetyBlocksPredictionOverride(bashClassification, bashCommand)) {
          return {
            decision: "deny",
            reason: `User's latest transcript message implies Bash, but Bash safety policy blocks this command. ${bashClassification.reason ?? "command is blocked"}`,
          };
        }
      }
      return {
        decision: "allow",
        reason: `User's latest transcript message is a class-level imperative implying ${toolName} (cached prediction was stale); ${toolName} proceeds.`,
      };
    }
  }

  // 3.8. Self-contradicting-deny override via cached intent prose.
  //
  // Root-cause fix for the "intent paraphrase names the very action
  // being denied" bug class. The cached `prediction.intent` is the
  // SENTIMENT_AGENT's prose summary of what the user wants. When that
  // paraphrase explicitly names the same target the firing call
  // carries (e.g. intent says "to read /plan3" and toolInput carries
  // skill="plan3"), a deny here is the hook contradicting itself —
  // it correctly understood the user wants X, then would block X.
  //
  // Generic via TOOL_TARGET_EXTRACTORS: tools without an extractor
  // return [] and this step is inert. Initial coverage is Skill —
  // the bug under repair. The map is the extension point when future
  // fixtures surface analogous shapes for other tools.
  //
  // Strict guards mirror 3.7:
  //   - blockedForThisToolByName already computed above (line 516)
  //   - EXPLICIT_PROHIBITION_RE on userMessageSnippet (parallel to
  //     step 3.6's userSaidProhibition guard at line 480) — a
  //     categorical "freeze. no tools." in the snippet still denies.
  //   - intentRevokesTarget against the intent — a paraphrase like
  //     "user wants AI to STOP reading /plan3" still denies via
  //     step 4.
  if (!blockedForThisToolByName && !userSaidProhibition) {
    const targets = extractToolTargets(toolName, toolInput);
    for (const target of targets) {
      if (
        intentNamesTarget(prediction.intent, target) &&
        !intentRevokesTarget(prediction.intent, target)
      ) {
        return {
          decision: "allow",
          reason: `Cached prediction.intent explicitly names the firing target "${target}" for ${toolName}; denying would contradict the hook's own paraphrase of the user's wish.`,
        };
      }
    }
  }

  // 3.9. Self-contradicting-block prose-intent fallback. Symmetric to step
  // 3a's INACTION_COMPLAINT_RE override (which catches "stop stalling"
  // framings of blockAllTools=true): when the cached intent describes the
  // AI/assistant/hook itself as having previously BLOCKED / PREVENTED /
  // REFUSED / DENIED carrying out the user's stated wish, mood-driven
  // deny would re-block the very tool call the cached paraphrase describes
  // as the bug. The cached signal IS the meta-complaint.
  //
  // Guards (mirror 3a/3.6/3.7):
  //   - userSaidProhibition: "freeze. no tools." in the snippet still wins.
  //   - blockedForThisToolByName: per-target structured block on the firing
  //     tool still wins (already authoritative via step 1, but the guard
  //     keeps the path family consistent).
  //
  // The match is on `intent` ALONE (not snippet) because the snippet captures
  // the user's WORDS, while intent is the hook's PARAPHRASE — the
  // contradiction lives in the paraphrase + deny pairing.
  if (
    !userSaidProhibition &&
    !blockedForThisToolByName &&
    SELF_CONTRADICTING_BLOCK_INTENT_RE.test(prediction.intent)
  ) {
    return {
      decision: "allow",
      reason: `Cached intent describes the AI itself as having previously blocked the user's stated wish; mood-driven re-deny of ${toolName} would compound that contradiction.`,
    };
  }

  // 3.10. Discharged-side-clarification fallback.
  //
  // Root-cause fix for the "cached prediction is anchored to a NESTED
  // side-clarification whose imperative was discharged by an intervening
  // completed tool round-trip; the still-active OUTER user turn favorably
  // authorizes the firing tool" bug class. The user's nested clarification
  // on a side topic does NOT retract their earlier request (mirrors
  // TOOL_APPEAL_AGENT rule 1's "nested clarification on a side topic"
  // carve-out brought into the deterministic policy because prediction-
  // block is appealable: false — no LLM appeal can rescue this).
  //
  // Strict guards mirror 3.6-3.9:
  //   - userSaidProhibition: "freeze. no tools." in the snippet still wins.
  //   - blockedForThisToolByName: per-target structured block on this tool
  //     still wins.
  //   - cachedSnippetSideTaskDischarged: pre-tool-use observed a completed
  //     non-error tool round-trip after the snippet's anchor turn. Without
  //     it the cached prediction is the freshest open imperative — fall
  //     through to normal mood policy.
  //   - recentUserMessages.length >= 2: at least one OLDER user-text turn
  //     exists (the freshest IS the discharged side-clarification anchor).
  //   - An older user-text turn favorably names the firing tool AND no
  //     subsequent message revokes the tool or matches
  //     EXPLICIT_PROHIBITION_RE.
  //
  // Generic over tool: piggybacks on TOOL_NAME_ALIASES + canonical-name
  // matching via latestUserMessageFavorablyNamesTool, so any tool whose
  // outer authorization the user phrased favorably is covered.
  if (
    cachedSnippetSideTaskDischarged &&
    !userSaidProhibition &&
    !blockedForThisToolByName &&
    recentUserMessages.length >= 2
  ) {
    const olderMessages = recentUserMessages.slice(0, -1);
    for (let i = olderMessages.length - 1; i >= 0; i--) {
      const candidate = olderMessages[i];
      if (!latestUserMessageFavorablyNamesTool(candidate, toolName)) continue;
      const subsequent = recentUserMessages.slice(i + 1);
      if (subsequent.some((m) => userMessageRevokesTool(m, toolName))) continue;
      if (subsequent.some((m) => EXPLICIT_PROHIBITION_RE.test(m))) continue;
      return {
        decision: "allow",
        reason: `Cached prediction is anchored to a discharged side-clarification (intervening tool round-trip obeyed it); an earlier still-active user turn favorably names ${toolName}; mood-driven re-deny would treat the nested clarification as a replacement intent.`,
      };
    }
  }

  // 3.11. Active slash-command authorization.
  //
  // Compatibility fallback for simple slash-command tool authorization. Strict
  // workflow steps that need ordering or input constraints are handled above
  // by explicitlyRequiredTools/nonBlockingTools derived from the command or
  // skill body; this fallback must not authorize broad Agent dispatches.
  //
  // The appealHelper LLM already grants this exemption when it sees
  // `=== SLASH COMMAND INVOKED ===` listing the firing tool
  // (TOOL_APPEAL_AGENT prompt rule, agent-configs.ts:565-576); bring the
  // same logic into the deterministic policy because prediction-block is
  // appealable: false, so the LLM rescue never fires here.
  //
  // The slash-command tag persists across the multi-step workflow until a
  // NEW slash command shadows the tag or the user issues an explicit
  // revocation (caught by the guards below).
  //
  // Strict guards mirror 3.6-3.10:
  //   - userSaidProhibition: a categorical "freeze. no tools." in the
  //     snippet still wins (computed at line 701).
  //   - blockedForThisToolByName: per-target structured block on the firing
  //     tool still wins (computed at line 737).
  if (
    !userSaidProhibition &&
    !blockedForThisToolByName &&
    !isAgentTool &&
    slashCommandAllowedTools.some((t) => matchesToolIdentity(t))
  ) {
    return {
      decision: "allow",
      reason: `Active slash command authorizes ${toolName} (per SLASH_COMMAND_ALLOWED_TOOLS); mood-driven re-deny would block the workflow the user explicitly invoked.`,
    };
  }

  // 3.12. Angry action-demand fallback for low-risk tools. If the prediction's
  // own intent says the user is demanding the AI do/perform/fix/check/continue
  // work, and there is no explicit prohibition or per-tool block, do not
  // convert anger into a blanket denial of harmless inspection. This does NOT
  // authorize arbitrary mutation or unrelated workflow tools; edit-class tools
  // are handled by explicit allow / undo / fresh imperative paths above.
  if (
    !userSaidProhibition &&
    !blockedForThisToolByName &&
    !prediction.blockedIntent &&
    isLowRiskInspectionTool(toolName) &&
    ACTION_DEMAND_INTENT_RE.test(prediction.intent)
  ) {
    return {
      decision: "allow",
      reason: `User intent demands action rather than prohibiting tools; mood-driven denial of ${toolName} would block the requested work.`,
    };
  }

  // 3.13. Full-message edit-intent consistency. The same full user message
  // that is stored on the prediction must not be mood-denied as "unless
  // explicitly requested" when that full text contains the edit request past
  // the display-snippet boundary. Keep this after the narrower historical
  // fallbacks so their reasons and ordering stay stable. Do not use prose
  // `intent` here; that would broaden the mood policy beyond the full-message
  // truncation fix.
  if (
    isPredictionEditTool(toolName) &&
    fullMessageEditIntent === true
  ) {
    return {
      decision: "allow",
      reason: `Full user message expresses edit intent; ${toolName} is explicitly requested.`,
    };
  }

  // 4. Mood-driven default policy. Allow set mirrors `low-risk-bypass`
  // (single source of truth via isLowRiskTool) so the prediction system
  // doesn't artificially block tools the framework treats as always-safe
  // — UNLESS the user is in SUSTAINED FRUSTRATION (mood angry/frustrated
  // AND trust=low OR frustrationStreak >= 2). Mirrors the TOOL_APPEAL_AGENT
  // prompt's "MOOD-DRIVEN DENIALS GENERALIZE UNDER SUSTAINED FRUSTRATION"
  // rule (src/utils/agent-configs.ts:643-646) so the deterministic policy
  // and the LLM appeal judge agree on the same threshold. Under sustained
  // frustration, low-risk tool calls without explicit authorization are
  // tangential inspection / deflection, not benign discovery — fall
  // through to the mood-deny path.
  const restrictive =
    prediction.mood === "angry" ||
    prediction.mood === "frustrated" ||
    prediction.trust === "low";
  if (restrictive) {
    const sustainedFrustration = isSustainedFrustration(
      prediction,
      frustrationStreak,
    );

    if (bashClassification?.riskClass === "simple-read-only") {
      return { decision: "allow" };
    }

    if (isLowRiskTool(toolName) && !sustainedFrustration) {
      return { decision: "allow" };
    }

    // Anger scoped to other tools via explicitlyBlockedSubstrings must not
    // generalize to this tool. When the user has expressed explicit blocks
    // AND none of them target the current tool, the sentiment is already
    // encoded in the substring list -- step 2 above is the authoritative
    // check for those tools. Falling into a blanket mood-deny here would
    // punish unrelated tools for a scoped grievance.
    const hasAnyExplicitBlock = prediction.explicitlyBlockedSubstrings.length > 0;
    const anyBlockTargetsThisTool = prediction.explicitlyBlockedSubstrings.some(
      (b) => matchesToolIdentity(b.tool),
    );
    if (hasAnyExplicitBlock && !anyBlockTargetsThisTool) {
      return { decision: "allow" };
    }

    return {
      decision: "deny",
      reason: `User appears ${prediction.mood} (trust: ${prediction.trust}, frustrationStreak: ${frustrationStreak}). Blocking ${toolName} unless explicitly requested. User said: "${displayUserMessage}". Intent: ${prediction.intent}`,
    };
  }

  // 5. neutral/satisfied/happy + normal/high trust → allow.
  return { decision: "allow" };
}

/**
 * Stop-hook helper: only block stopping when the user is genuinely hostile.
 * Replaces the legacy `blockStop` boolean field.
 */
export function isHighFrictionPrediction(p: ToolPrediction | null): boolean {
  return !!p && (p.mood === "angry" || p.mood === "frustrated" || p.trust === "low");
}

/**
 * Serialize the entire tool input for literal substring search. Using full
 * JSON.stringify covers every tool shape (Bash.command, Edit.file_path,
 * Edit.new_string, Glob.pattern, Grep.pattern, WebFetch.url, mcp__*.<arbitrary>,
 * etc).
 */
export function stringifyToolInput(toolInput: unknown): string {
  try {
    return JSON.stringify(toolInput);
  } catch {
    return "";
  }
}

/**
 * Format a prediction as readable context. Single source of truth — used by
 * both the gate-LLM context builder and the SENTIMENT_AGENT's "previous
 * prediction" input field.
 */
export function formatPredictionContext(p: ToolPrediction): string {
  const lines: string[] = [
    `User mood: ${p.mood}`,
    `User trust: ${p.trust}`,
    `User message: ${predictionUserMessageForLogic(p)}`,
    `Intent: ${p.intent}`,
  ];
  if (p.blockedIntent) lines.push(`Blocked intent: ${p.blockedIntent}`);
  if (p.explicitlyAllowedTools.length) {
    lines.push(`Explicitly allowed tools: ${p.explicitlyAllowedTools.join(", ")}`);
  }
  if (p.explicitlyRequiredTools?.length) {
    lines.push(`Explicitly required tools: ${p.explicitlyRequiredTools.map(formatToolRequirement).join(" -> ")}`);
  }
  if (p.nonBlockingTools?.length) {
    lines.push(`Non-blocking tools: ${p.nonBlockingTools.map(formatToolRequirement).join(", ")}`);
  }
  if (p.explicitlyBlockedSubstrings.length) {
    const blocks = p.explicitlyBlockedSubstrings
      .map(
        (b) =>
          `${b.tool}${b.targetSubstring ? ` (substring: ${b.targetSubstring})` : ""} — ${b.reason}`,
      )
      .join("; ");
    lines.push(`Explicitly blocked: ${blocks}`);
  }
  return lines.join("\n");
}
