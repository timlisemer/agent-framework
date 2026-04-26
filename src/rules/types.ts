import type { SessionState } from "../utils/session-store.js";
import type { CacheManager } from "../utils/cache-manager.js";
import type { Mood, Trust } from "../utils/prediction-types.js";

export interface RuleContext {
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  projectDir: string;
  transcriptPath: string;
  sessionDir: string;
  sessionId: string;
  state: SessionState;
  stateManager: CacheManager<SessionState>;
  planMode: boolean;
  planModeCtx: { active: boolean; contextString: string };
  subagent: boolean;
  /**
   * Set by pre-tool-use.ts when the current file tool call targets an
   * absolute path that is OUTSIDE projectDir AND is NOT a Claude plan file.
   * Deterministic classification. Downstream LLM gates (tool-approve,
   * rule-gate) read this and inject a harsh "be extra conservative" warning
   * into their prompts. Undefined means in-project, a plan file, or not a
   * file-tool call.
   */
  outsideRootPath?: string;
}

export type RuleCheckResult =
  | null
  | { fastDeny: string }
  | { fastAllow: string }
  | { llmContext: string };

export interface AppealUserState {
  mood: Mood | null;
  trust: Trust | null;
  frustrationStreak: number;
  userMessageSnippet: string;
  intent: string;
  blockedIntent: string;
  blockAllTools: boolean;
  explicitlyAllowedTools: string[];
  explicitlyBlockedSubstrings: Array<{
    tool: string;
    targetSubstring?: string;
    reason: string;
  }>;
  /**
   * True when (mood is angry/frustrated) AND (trust=low OR
   * frustrationStreak >= 2). Mirrors `isSustainedFrustration` in
   * `prediction-types.ts` so the appeal LLM reads the same predicate the
   * deterministic policy uses.
   */
  sustainedFrustration: boolean;
  /**
   * True when the user's full prompt contained an explicit override phrase
   * ("override the block", "do it anyway", etc.). Mirrors
   * `currentPrediction.hasExplicitOverride`.
   */
  hasExplicitOverride: boolean;
}

export interface PreToolRule {
  name: string;
  displayName: string;
  priority: number;
  appealable: boolean;
  /** Whether this rule involves an LLM call. Used by exitPipeline to decide
   *  whether to write gate reasoning entries. Replaces the hardcoded isLlmAgent array. */
  usesLlm: boolean;
  check(ctx: RuleContext): Promise<RuleCheckResult>;
  promptSection: string;
  /** Optional hook called when denial is confirmed (appeal failed or not appealable).
   *  Used by tool-approve for detectWorkaroundPattern/recordDenial and to set
   *  state.forceCheckPending so the force-check-required rule can lock the
   *  session to mcp__agent-framework__check on the next turn. */
  onDenialConfirmed?(ctx: RuleContext, reason: string): Promise<void>;
}
