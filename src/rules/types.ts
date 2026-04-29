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
  /**
   * The user's latest non-meta text message from the live transcript at
   * PreToolUse entry, with quoted/pasted content stripped. Independent of
   * `state.currentPrediction.userMessageSnippet`, which can be stale when
   * sentiment refresh failed/timed out/anchored on a prior negative read,
   * and is also capped at 200 chars by user-prompt-submit. Optional so
   * unit-test ctx mocks don't have to populate it; consumers must treat
   * undefined/empty as "no fresh information available".
   *
   * Rules that need to recognize a fresh explicit user signal (e.g.
   * prediction-block's redirect/re-authorization fallback) read this
   * instead of `state.currentPrediction.userMessageSnippet`.
   */
  latestUserMessage?: string;
  /**
   * The last 5 non-meta, non-slash-command, quoted/pasted-stripped user-
   * text turns from the transcript at PreToolUse entry, OLDEST-FIRST.
   * Read once in pre-tool-use.ts and threaded so prediction-block /
   * decidePrediction step 3.10 can scan for an outer user turn that
   * authorizes the firing tool when the cached prediction is anchored on
   * a discharged side-clarification. Optional so unit-test mocks can omit
   * it; consumers must treat undefined/[] as "no fresh authorization
   * information available".
   */
  recentUserMessages?: string[];
  /**
   * Set by pre-tool-use.ts when:
   *   (a) state.currentPrediction is non-null, AND
   *   (b) the user-text turn matching prediction.userMessageSnippet has
   *       been followed by at least one completed non-error assistant
   *       tool round-trip (the side-clarification imperative has been
   *       discharged).
   *
   * Read by decidePrediction step 3.10. Default false / undefined means
   * "the cached prediction's source turn is still the freshest open
   * imperative — apply normal mood policy".
   */
  cachedSnippetSideTaskDischarged?: boolean;
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
