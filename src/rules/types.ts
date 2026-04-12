import type { SessionState } from "../utils/summary-cache.js";
import type { CacheManager } from "../utils/cache-manager.js";

export interface RuleContext {
  toolName: string;
  toolInput: unknown;
  projectDir: string;
  transcriptPath: string;
  sessionDir: string;
  sessionId: string;
  state: SessionState;
  stateManager: CacheManager<SessionState>;
  planMode: boolean;
  planModeCtx: { active: boolean; contextString: string };
  subagent: boolean;
  coldStart: boolean;
  useSyncPipeline: boolean;
  toolCallCount: number;
}

export type RuleCheckResult =
  | null
  | { fastDeny: string }
  | { fastAllow: string }
  | { llmContext: string };

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
   *  Used by tool-approve for detectWorkaroundPattern/recordDenial/savePrediction. */
  onDenialConfirmed?(ctx: RuleContext, reason: string): Promise<void>;
}
