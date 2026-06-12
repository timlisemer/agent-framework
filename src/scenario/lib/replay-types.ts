/**
 * Shared types for the transcript replay test harness.
 *
 * @module test-harness/lib/types
 */

import type { Mood, Trust } from "../../utils/prediction-types.js";
import type { ExpectationEntry, RichExpectation } from "../labels.js";
import type {
  ReasonMustResult,
} from "../types.js";

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
  /** Per-clause results when the label's `reason_must` was scored. */
  reason_must_results?: ReasonMustResult[];
  /**
   * Hook's raw reason string verbatim. PreToolUse/PostToolUse: the
   * gate-attributed reason from `tool-log.jsonl`. Stop hook: the reason from
   * the hook's stdout JSON. Differs from the overloaded `reason` field
   * (which carries scoring-failure messages OR hook reason) because
   * per-hook-kind dispatch is non-obvious.
   */
  actual_reason?: string;
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

export type { ExpectationEntry, PredictionAnnotation, RichExpectation } from "../labels.js";

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
// Scenario types + validateScenario live in src/scenario/types.ts.
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
  ReasonMustExpectation,
  ReasonMustResult,
} from "../types.js";
export { validateScenario } from "../types.js";
