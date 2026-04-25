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
 * Pure decision function: given the current prediction (or null) and a tool
 * call, return allow/deny. Order: explicit allow > explicit block > mood
 * policy.
 */
export function decidePrediction(
  prediction: ToolPrediction | null,
  toolName: string,
  toolInput: unknown,
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

  // 3. blockAllTools override: user explicitly asked for no tools at all.
  // Overrides the low-risk allowance below — only explicitlyAllowedTools
  // bypass (already handled in step 1).
  if (prediction.blockAllTools) {
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

  // 4. Mood-driven default policy. Allow set mirrors `low-risk-bypass`
  // (single source of truth via isLowRiskTool) so the prediction system
  // doesn't artificially block tools the framework treats as always-safe.
  const restrictive =
    prediction.mood === "angry" ||
    prediction.mood === "frustrated" ||
    prediction.trust === "low";
  if (restrictive) {
    if (isLowRiskTool(toolName)) return { decision: "allow" };

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
      reason: `User appears ${prediction.mood} (trust: ${prediction.trust}). Blocking ${toolName} unless explicitly requested. User said: "${prediction.userMessageSnippet}". Intent: ${prediction.intent}`,
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
