/**
 * Shared types for the transcript replay test harness.
 *
 * @module test-harness/lib/types
 */

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
 * A rich expectation entry with optional rule match and truncation target.
 *
 * - `expected`: the decision the hook must produce ("allow" / "deny" for tool
 *   calls, "pass" / "block" for stops).
 * - `by`: optional rule name to match against tool-log `gate`. When set, the
 *   event only passes if the hook denied AND the denial came from this rule.
 * - `at`: optional truncation target. When set, this expectation is scored
 *   only when `replay.ts` is invoked with the matching `--truncate-to-line`
 *   value (or "full" for the default post-flush state).
 */
export interface RichExpectation {
  expected: string;
  by?: string;
  at?: number | "full";
  notes?: string;
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
