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

import { isLowRiskTool } from "../rules/utils.js";
import { isEditTool } from "./edit-intent.js";

export type Mood = "angry" | "frustrated" | "neutral" | "satisfied" | "happy";
export type Trust = "low" | "normal" | "high";

export interface ToolPrediction {
  mood: Mood;
  trust: Trust;
  /** 1-2 sentences: what the user wants. */
  intent: string;
  /** 1-2 sentences: what the user explicitly does NOT want, or "". */
  blockedIntent: string;

  /** LITERAL tool names — exact match, no regex. */
  explicitlyAllowedTools: string[];

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

  userMessageSnippet: string;
  timestamp: number;

  /** Window size proposal for the NEXT UserPromptSubmit (raw, unclamped). */
  nextWindowSize?: number;
  /** Whether the user just changed topic / opened a new unrelated task. */
  contextSwitch?: "yes" | "no";
  /**
   * Only meaningful when SENTIMENT_AGENT was invoked with ASKUSERQUESTION CONTENT.
   * Otherwise "n/a".
   */
  questionIsStalling?: "yes" | "no" | "n/a";
}

export interface PredictionDecision {
  decision: "allow" | "deny";
  reason?: string;
  matchedExplicit?: { tool: string; targetSubstring?: string; reason: string };
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
  /\b(undo\w*|revert\w*|restor\w*|rollback\w*|roll\s+back|put\s+back|rewrit\w*|redo\w*)\b/i;

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
 * Pure decision function: given the current prediction (or null) and a tool
 * call, return allow/deny. Order: explicit allow > explicit block > mood
 * policy.
 */
export function decidePrediction(
  prediction: ToolPrediction | null,
  toolName: string,
  toolInput: unknown,
  frustrationStreak: number,
): PredictionDecision {
  if (!prediction) return { decision: "allow" };

  // 1. Explicit allow wins.
  if (prediction.explicitlyAllowedTools.includes(toolName)) {
    return { decision: "allow" };
  }

  // 2. Explicit block wins.
  const inputStr = stringifyToolInput(toolInput);
  for (const blk of prediction.explicitlyBlockedSubstrings) {
    if (blk.tool !== toolName) continue;
    if (blk.targetSubstring && !inputStr.includes(blk.targetSubstring)) continue;
    return {
      decision: "deny",
      reason: `User explicitly forbade this in their last message: "${prediction.userMessageSnippet}". ${blk.reason}`,
      matchedExplicit: blk,
    };
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
    const userSaidProhibition = EXPLICIT_PROHIBITION_RE.test(
      prediction.userMessageSnippet,
    );
    const blockedForThisTool = prediction.explicitlyBlockedSubstrings.some(
      (b) => b.tool === toolName,
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
      reason: `User explicitly asked for no tools right now. User said: "${prediction.userMessageSnippet}". Intent: ${prediction.intent}`,
    };
  }

  // 3.5. Undo-intent fallback. The LLM-derived intent already encodes whether
  // the user wants the AI to revert file changes it made. If that signal is
  // present and the requested tool is an edit tool, allow — even when
  // explicitlyAllowedTools is empty (covers cases where SENTIMENT_AGENT
  // captured the verb in intent text but missed the structured authorization).
  // Step 2 (explicit blocks) and step 3 (blockAllTools) still win above.
  if (isEditTool(toolName)) {
    const undoText = `${prediction.intent} ${prediction.userMessageSnippet}`;
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
  const userSaidProhibition = EXPLICIT_PROHIBITION_RE.test(
    prediction.userMessageSnippet,
  );
  if (
    !userSaidProhibition &&
    RE_AUTHORIZATION_INTENT_RE.test(prediction.intent)
  ) {
    return {
      decision: "allow",
      reason: `User intent expresses an explicit re-authorization to proceed; ${toolName} proceeds.`,
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
    const sustainedFrustration =
      (prediction.mood === "angry" || prediction.mood === "frustrated") &&
      (prediction.trust === "low" || frustrationStreak >= 2);

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
      (b) => b.tool === toolName,
    );
    if (hasAnyExplicitBlock && !anyBlockTargetsThisTool) {
      return { decision: "allow" };
    }

    return {
      decision: "deny",
      reason: `User appears ${prediction.mood} (trust: ${prediction.trust}, frustrationStreak: ${frustrationStreak}). Blocking ${toolName} unless explicitly requested. User said: "${prediction.userMessageSnippet}". Intent: ${prediction.intent}`,
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
    `Intent: ${p.intent}`,
  ];
  if (p.blockedIntent) lines.push(`Blocked intent: ${p.blockedIntent}`);
  if (p.explicitlyAllowedTools.length) {
    lines.push(`Explicitly allowed tools: ${p.explicitlyAllowedTools.join(", ")}`);
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
