/**
 * Shared types for the test harness.
 *
 * @module test-harness/lib/types
 */

/**
 * Result of a single hook test execution.
 */
export interface TestResult {
  pass: boolean;
  hook: string;
  decision: string;
  expected: string;
  agent?: string;
  expectedAgent?: string;
  reason?: string;
  label?: string;
  ms: number;
  error?: string;
}

/**
 * A tool_use entry extracted from a transcript for list mode.
 */
export interface ToolUseEntry {
  line: number;
  toolName: string;
  toolInput: unknown;
  toolUseId: string;
  planModeActive: boolean;
  precedingUserMessage?: string;
}

/**
 * CacheState wrapper format used by all session state files.
 */
export interface CacheState<T> {
  sessionId: string;
  data: T;
}

/**
 * SessionState as expected by the framework's state.json.
 */
export interface SessionState {
  lastUserMessageHash: string;
  summaryVersion: number;
  toolCallCount: number;
  toolCallsSinceUpdate: number;
  lastUpdated: number;
  currentEditIntent: boolean | null;
  previousEditIntent: boolean | null;
  editIntentTimestamp: number;
  editIntentOverturnCount: number;
}

/**
 * Default SessionState factory with optional overrides.
 */
export function defaultSessionState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    lastUserMessageHash: "",
    summaryVersion: 0,
    toolCallCount: 10,
    toolCallsSinceUpdate: 10,
    lastUpdated: Date.now(),
    currentEditIntent: null,
    previousEditIntent: null,
    editIntentTimestamp: 0,
    editIntentOverturnCount: 0,
    ...overrides,
  };
}

/**
 * CLI arguments parsed from run.ts.
 */
export interface HarnessArgs {
  hook: "pre-tool-use" | "stop-response-check";
  transcript: string;
  line: number;
  expect: string;
  expectAgent?: string;
  label?: string;
  cwd?: string;
  editIntent?: boolean | null;
  toolCallCount?: number;
  timeout: number;
}
