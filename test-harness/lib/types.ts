/**
 * Shared types for the transcript replay test harness.
 *
 * @module test-harness/lib/types
 */

import type { Mood, Trust } from "../../src/utils/prediction-types.js";

/**
 * Snapshot of the live active prediction at fire-time, captured during the
 * per-event loop so the post-loop write block can read pre-mutation state.
 */
export interface LivePredictionSnapshot {
  mood: Mood;
  trust: Trust;
  intent: string;
  blockedIntent: string;
  explicitlyAllowedTools: string[];
  explicitlyBlockedSubstrings: Array<{
    tool: string;
    targetSubstring?: string;
    reason: string;
  }>;
  /** When the deny matched an explicit block entry, the matching entry. */
  matchedExplicit?: { tool: string; targetSubstring?: string; reason: string };
}

/**
 * A single hook invocation result emitted as JSONL.
 */
export interface ReplayEvent {
  line: number;
  hook: string;
  decision: string;
  tool?: string;
  id?: string;
  gate?: string;
  reason?: string;
  expected?: string;
  /** Rule/gate name demanded by the label's `by` field, when set. */
  gate_expected?: string;
  pass?: boolean;
  /** Truncation this scoring was produced under: a 1-based line index or "full". */
  at?: number | "full";
  ms: number;
  error?: string;
  /**
   * Snapshot of the active prediction that caused this fire's deny, captured
   * during the per-event loop. Only set when `gate ∈ {"prediction-block",
   * "batch-sibling"}` (the latter only when the leader's gate was
   * `prediction-block`). Consumed by --generate-labels post-loop write.
   */
  livePrediction?: LivePredictionSnapshot;
}

/**
 * Final summary line emitted after all hook invocations.
 */
export interface ReplaySummary {
  type: "summary";
  total: number;
  scored: number;
  passed: number;
  failed: number;
  errors: number;
  ms: number;
}

/**
 * Hindsight verdict on a prediction that fired and produced a deny.
 *
 * Set ONLY when the deny's gate was `prediction-block` (or a batch sibling
 * inheriting from a prediction-block leader). The auto-labeler writes
 * `verdict: "correct"` by default; the reviewer flips to `too_broad` /
 * `wrong` / `INVESTIGATE` per the trust hierarchy in claude/agents/labeler.md.
 */
export interface PredictionAnnotation {
  /** Reviewer's hindsight verdict on the prediction that caused this deny. */
  verdict: "correct" | "too_broad" | "wrong" | "INVESTIGATE";
  /**
   * For too_broad verdicts: what the prediction's explicitlyBlockedSubstrings
   * MUST NOT contain after narrowing. Each entry is a {tool, target_pattern}
   * filter; live scoring fails if any matches. `tool` is a LITERAL tool name
   * (no regex metachars).
   */
  forbidden_blocks?: Array<{ tool?: string; target_pattern?: string }>;
  /**
   * Optional: substring that must appear in the live prediction's `intent`
   * field. Auto-populated during scaffold with first 60 chars of live intent.
   * Catches sentiment predictions drifting to a different concept.
   */
  intent_must_contain?: string;
  /** Optional: assert the live prediction's mood field equals this value. */
  expected_mood?: Mood;
  /** Optional: assert the live prediction's trust field equals this value. */
  expected_trust?: Trust;
  /** Optional reviewer note. */
  notes?: string;
}

/**
 * A rich expectation entry with optional rule match and truncation target.
 *
 * - `expected`: the decision the hook must produce ("allow" / "deny" for tool
 *   calls, "pass" / "block" for stops).
 * - `by`: optional rule name to match against tool-log `gate`. When set, the
 *   event only passes if the hook denied AND the denial came from this rule.
 * - `at`: optional truncation target. When set, this expectation is scored
 *   only when `replay.ts` is invoked with the matching `--truncate-to-line`
 *   value (or "full" for the default post-flush state).
 * - `prediction`: optional hindsight annotation on a prediction-block deny.
 *   Set ONLY when `expected === "deny"` AND `by ∈ {"prediction-block",
 *   "batch-sibling"}` (the latter only when the leader's gate was
 *   `prediction-block`). Undefined for any other label.
 */
export interface RichExpectation {
  expected: string;
  by?: string;
  at?: number | "full";
  notes?: string;
  prediction?: PredictionAnnotation;
}

export type ExpectationEntry = string | RichExpectation | RichExpectation[];

/**
 * Expectations map: tool_use_id (or prefix) -> expected decision,
 * or "stop:<line>" -> expected decision.
 *
 * Values may be:
 * - a legacy string ("allow" | "deny" | "pass" | "block")
 * - a single RichExpectation object
 * - an array of RichExpectation objects (for labeling the same hook under
 *   multiple truncation states, e.g. pre-flush vs post-flush).
 */
export type ReplayExpectations = Record<string, ExpectationEntry>;

/**
 * Parsed CLI arguments for replay.ts.
 */
export interface ReplayArgs {
  transcript: string;
  expect?: ReplayExpectations;
  expectPath?: string;
  cwd?: string;
  timeout: number;
  list: boolean;
  expand?: string;
  depth: number;
  scaffold: boolean;
  validate: boolean;
  generateLabels: boolean;
  filter?: string;
  /**
   * Optional 1-based line cap. When set, replay appends only transcript
   * entries whose 1-based line index is <= truncateToLine before firing the
   * target hook. The target hook still fires with its full `tool_use_id`
   * because the hook input is synthesized from the in-memory parsed lines,
   * not from the on-disk temp transcript. Only meaningful with `filter`.
   */
  truncateToLine?: number;
}

/**
 * Normalize an expectation entry into an array of RichExpectation objects.
 * Accepts legacy string values, single rich objects, or arrays of rich
 * objects. Intended as the single call site through which all scoring and
 * validation accesses label values.
 */
export function normalizeExpectation(
  entry: ExpectationEntry | undefined,
): RichExpectation[] {
  if (entry === undefined) return [];
  if (typeof entry === "string") return [{ expected: entry }];
  if (Array.isArray(entry)) return entry;
  return [entry];
}

// ─── Scenario Testing (synthetic transcripts) ──────────────────────────────
//
// Scenario types + validateScenario live in src/agents/mcp/scenario-types.ts
// so src-side MCP handlers can import them (tsconfig rootDir is src/).
// Re-exported here as a convenience for test-harness consumers.

export type {
  HookEventName,
  PermissionMode,
  ScenarioBlock,
  ScenarioUserEntry,
  ScenarioAssistantEntry,
  ScenarioEntry,
  ScenarioTarget,
  ScenarioEnv,
  Scenario,
  ScenarioResult,
  FanoutFireResult,
} from "../../src/agents/mcp/scenario-types.js";
export { validateScenario } from "../../src/agents/mcp/scenario-types.js";
