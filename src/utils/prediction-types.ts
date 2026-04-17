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

/**
 * Tools always permitted under restrictive mood. AskUserQuestion is
 * INTENTIONALLY KEPT — its content is judged by predictionQuestionJudgeRule
 * (priority 28) which calls SENTIMENT_AGENT with the question text injected.
 * Blanket-deny was rejected because legitimate operational questions
 * ("delete or back up first?") under angry mood should still be allowed.
 */
export const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "ToolSearch", "TodoWrite",
  "AskUserQuestion", "WebFetch", "WebSearch",
]);

export interface PredictionDecision {
  decision: "allow" | "deny";
  reason?: string;
  matchedExplicit?: { tool: string; targetSubstring?: string; reason: string };
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

  // 3. Mood-driven default policy.
  const restrictive =
    prediction.mood === "angry" ||
    prediction.mood === "frustrated" ||
    prediction.trust === "low";
  if (restrictive) {
    if (READ_ONLY_TOOLS.has(toolName)) return { decision: "allow" };
    return {
      decision: "deny",
      reason: `User appears ${prediction.mood} (trust: ${prediction.trust}). Blocking ${toolName} unless explicitly requested. User said: "${prediction.userMessageSnippet}". Intent: ${prediction.intent}`,
    };
  }

  // 4. neutral/satisfied/happy + normal/high trust → allow.
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
