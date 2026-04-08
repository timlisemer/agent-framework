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
  pass?: boolean;
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
 * Expectations map: tool_use_id (or prefix) -> expected decision,
 * or "stop:<line>" -> expected decision.
 */
export type ReplayExpectations = Record<string, string>;

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
}
