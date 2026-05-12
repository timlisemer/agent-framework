/**
 * Scenario testing types and validator.
 *
 * Lives under src/ (not test-harness/) so src-side MCP handlers can
 * import and validate incoming scenario objects. test-harness/scenario.ts
 * imports from here as well via a relative path.
 *
 * @module scenario-types
 */

import type { Mood, ToolPrediction, Trust } from "../utils/prediction-types.js";
import { registeredAdapterNames } from "../adapter/spec.js";
import type { PlanModeStoredState } from "../utils/plan-mode-entry-state.js";
import type { SessionInjectionRecord } from "../utils/session-injections.js";

/** Which hook a scenario targets. */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "UserPromptSubmit"
  | "SessionStart"
  | "PostToolUseFailure";

/**
 * Reason-text assertion clauses. All present clauses must hold (AND); multiple
 * entries inside one array are also AND-ed (use multiple entries to require
 * multiple substrings; collapse to `|`-alternation if you need OR). Only valid
 * when `expected ∈ {deny, block}`.
 */
export interface ReasonMustExpectation {
  contains?: string[];
  not_contains?: string[];
  matches?: string[];
  not_matches?: string[];
}

/**
 * One result entry per reason_must clause checked. Returned by
 * `evaluateReasonMust` and surfaced through ScoreContext / ScenarioResult so
 * failure reports can pinpoint the violating clause.
 */
export interface ReasonMustResult {
  kind: "contains" | "not_contains" | "matches" | "not_matches";
  pattern: string;
  pass: boolean;
}

/** Claude Code native plan-mode permission values. */
export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "bypassPermissions"
  | "dontAsk";

/** A single content block in a scenario user or assistant entry. */
export type ScenarioBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id?: string; name: string; input: Record<string, unknown> }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | unknown[];
      is_error?: boolean;
    };

export interface ScenarioUserEntry {
  role: "user";
  content: string | ScenarioBlock[];
  /**
   * When true the materialized jsonl line is marked `isMeta: true` --
   * Claude Code's flag for system-injected user messages (slash-command
   * bodies, stop-hook feedback, local-command-caveat). Required to
   * reproduce live transcripts where the meta-skip filter changes which
   * user message reaches rules like respond-first.
   *
   * TODO: make isMeta REQUIRED (remove the `?`). Every scenario author must
   * declare true or false explicitly so the flag is never silently omitted.
   * Same principle applies to every other currently-optional declaration on
   * Scenario / ScenarioUserEntry / ScenarioAssistantEntry /
   * ScenarioAssistantSplitEntry / ScenarioTarget / ScenarioEnv / seed_state:
   * scenarios are a declarative contract, so every field the harness consults
   * must be explicitly stated by the author (true/false, present/absent,
   * value/[]). Optional-with-default hides intent and lets bugs slip in.
   * Migration requires adding the field to every existing fixture under
   * test-harness/fixtures/scenarios/{working,broken,todo}/ and to every
   * stored copy under ~/.agent-framework/test-runs/scenarios/.
   */
  isMeta?: boolean;
}

export interface ScenarioAssistantEntry {
  role: "assistant";
  content: ScenarioBlock[];
}

/**
 * A single logical assistant API message authored as multiple jsonl lines
 * that share one `message.id`. Reproduces Claude Code's split-message
 * write pattern (thinking / text / tool_use each on their own line). The
 * materializer writes one jsonl line per `lines[j]`, all carrying the
 * same `msg_id`, in the order given.
 */
export interface ScenarioAssistantSplitEntry {
  role: "assistant_split";
  msg_id: string;
  lines: Array<{ blocks: ScenarioBlock[] }>;
}

export type ScenarioEntry =
  | ScenarioUserEntry
  | ScenarioAssistantEntry
  | ScenarioAssistantSplitEntry;

/** Target hook + which tool_use / prompt to fire for. */
export interface ScenarioTarget {
  hook: HookEventName;
  /**
   * For PreToolUse / PostToolUse. Either a specific tool_use_id that
   * matches a block inside the transcript, or the literal "last" which
   * resolves to the final tool_use block in the final assistant entry.
   * When omitted, "last" is assumed.
   */
  tool_use_ref?: string | "last";
  /**
   * For UserPromptSubmit only. The prompt string the hook sees. Defaults
   * to the final user entry's text.
   */
  prompt_override?: string;
  /**
   * For PreToolUse / PostToolUse against a parallel tool_use batch
   * authored as an `assistant_split`. 0-based inclusive index into the
   * FINAL entry's `lines` array. When set, the materializer stops
   * flushing the final split after this sub-line, reproducing the
   * on-disk state at the instant sub-line K's hook fires in real
   * Claude Code (only positions 0..K are on disk yet). Requires the
   * final transcript entry to be `role: "assistant_split"` and
   * `tool_use_ref` to be an explicit concrete id pointing inside the
   * visible slice. See `validateScenario` for the full rule set.
   */
  batch_visible_through?: number;
  /**
   * When true, the runner fires one PreToolUse hook per tool_use sub-line
   * in the final `assistant_split`, in order, with shared state
   * accumulating across fires in one cache dir. Mutually exclusive with
   * `tool_use_ref` and `batch_visible_through`. Requires `hook: PreToolUse`
   * and the final entry to be `assistant_split` of pure tool_use sub-lines
   * (optionally preceded by text/thinking sub-lines). Expect must be the
   * array form.
   */
  fanout?: boolean;
}

/**
 * Hindsight verdict on a prediction that fired and produced a deny.
 * Mirrors test-harness/lib/types.ts:PredictionAnnotation.
 */
export interface PredictionAnnotation {
  verdict: "correct" | "too_broad" | "wrong" | "INVESTIGATE";
  forbidden_blocks?: Array<{ tool?: string; target_pattern?: string }>;
  intent_must_contain?: string;
  expected_mood?: Mood;
  expected_trust?: Trust;
  notes?: string;
}

/**
 * Scenario-level prediction expectations evaluated AFTER the target hook
 * fires. Reads the live `state.json` `currentPrediction` and asserts
 * structural shape. `must_be_empty` is mutually exclusive with the per-filter
 * forms and the mood/trust/intent assertions.
 *
 * `tool` in the filter is a LITERAL tool name (no regex metachars).
 * `target_substring` is a LITERAL substring matched against the live
 * prediction's `explicitlyBlockedSubstrings[].targetSubstring`.
 */
export interface ScenarioPredictionExpectation {
  must_block?: Array<{ tool: string; target_substring?: string }>;
  must_not_block?: Array<{ tool: string; target_substring?: string }>;
  must_be_empty?: boolean;
  must_have_mood?: Mood;
  must_have_trust?: Trust;
  must_not_have_mood?: Mood[];
  must_not_have_trust?: Trust[];
  intent_must_contain?: string;
}

/** Environment / setup flags plumbed into the hook stdin and transcript. */
export interface ScenarioEnv {
  /** Copied verbatim into hook input.permission_mode and onto every
   *  transcript entry's permissionMode field. */
  permission_mode?: PermissionMode;
  /** Permission mode used only for the synthetic SessionStart preamble. */
  session_start_permission_mode?: PermissionMode;
  /** CLAUDE_PROJECT_DIR / hook cwd. Defaults to the scenario run dir. */
  cwd?: string;
  /** Hook timeout in milliseconds. Defaults to 60000. */
  timeout_ms?: number;
  /**
   * Adapter name to use when materializing and running this scenario.
   * Any registered adapter name (e.g. "claude", "codex"). Validated at
   * runtime against SPECS in src/adapter/spec.ts. Defaults to the active
   * adapter if omitted.
   */
  adapter?: string;
  /** Codex-only: materialize native collaboration-mode transcript markers. */
  codex_collaboration_mode?: "plan";
  /**
   * Per-agent LLM stub map: agent name (matching `telemetry.agent`) → exact
   * stubbed output text. Plumbed into the hook process via the
   * `AGENT_FRAMEWORK_LLM_STUBS` env var (JSON-encoded). Stubbing happens at
   * `runAgentWithRetryAndTelemetry`, so every agent that flows through the
   * agent-runner LLM transport boundary (tool-appeal, rule-gate, style-drift,
   * question-validate, edit-intent, plan-validate, etc.) can be made
   * deterministic. Authors write what the LLM would have returned, e.g.
   * `{ "tool-appeal": "UPHOLD" }` or `{ "rule-gate": "DENY: tool-approve: nope" }`.
   */
  llm_stubs?: Record<string, string>;
}

/** A complete synthetic test scenario for unit-testing a single hook rule. */
export interface Scenario {
  /** Schema version. 1 = today's shape; 2 = strict-required shape (materialized live captures). */
  schema_version: 1 | 2;
  /** Slug (must match [A-Za-z0-9._-]+). Used as the on-disk dir name. */
  name: string;
  /** Optional human description. Not scored. */
  description?: string;
  /** Transcript entries in order, oldest first. Must be non-empty. */
  transcript: ScenarioEntry[];
  /** Target hook + tool_use / prompt. */
  target: ScenarioTarget;
  /** Optional setup flags. */
  env?: ScenarioEnv;
  /** Files written under env.cwd before transcript materialization and hooks. */
  setup_files?: Array<{ path: string; content: string }>;
  /** Session sidecars seeded before the target hook. */
  seed_sidecars?: {
    plan_mode_state?: PlanModeStoredState | null;
    injections?: SessionInjectionRecord[];
  };
  /**
   * Scoring spec. Single form (reuses RichExpectation minus `at`) is used
   * when `target.fanout` is unset. Array form is used when
   * `target.fanout: true`; each entry is keyed by 0-based `position` into
   * the final `assistant_split.lines`. Positions not listed are fired but
   * not asserted (recorded in report, not a pass/fail input). Run passes
   * iff every listed position's fire matches its expectation.
   */
  expect:
    | {
        expected: string;
        by?: string;
        notes?: string;
        prediction?: PredictionAnnotation;
        reason_must?: ReasonMustExpectation;
        injections?: Array<{
          id: string;
          trigger: string;
          channel: "context";
          message_hash: string;
          message?: string;
        }>;
        context_output_hash?: string;
      }
    | Array<{
        position: number;
        expected: string;
        by?: string;
        notes?: string;
        prediction?: PredictionAnnotation;
        reason_must?: ReasonMustExpectation;
      }>;
  /**
   * Optional structural assertions on the live prediction-cache state AFTER
   * the target hook fires. See ScenarioPredictionExpectation. When set,
   * these assertions are AND-ed with the per-fire expect-pass result to
   * determine the run's `pass`.
   */
  predictions?: ScenarioPredictionExpectation;
  /**
   * Seed for `state.json`. Materialized BEFORE session-start fires, so the
   * hook pipeline observes the seeded state. Required for every scenario —
   * single-hook mode does NOT fire UserPromptSubmit before the target hook,
   * so a scenario author must declare the full prior-turn session state
   * explicitly. Every field is REQUIRED; `currentPrediction` must carry
   * every required `ToolPrediction` field. `timestamp` on the prediction is
   * the single optional slot — the runner fills it with `Date.now()` when
   * omitted so authors don't have to hand-pick a stamp.
   */
  seed_state: {
    currentPrediction: {
      mood: ToolPrediction["mood"];
      trust: ToolPrediction["trust"];
      intent: string;
      blockedIntent: string;
      explicitlyAllowedTools: string[];
      explicitlyBlockedSubstrings: ToolPrediction["explicitlyBlockedSubstrings"];
      userMessageSnippet: string;
      blockAllTools?: boolean;
      timestamp?: number;
      contextSwitch?: ToolPrediction["contextSwitch"];
      questionIsStalling?: ToolPrediction["questionIsStalling"];
    };
    forceCheckPending: boolean;
    frustrationStreak: number;
    currentWindowSize: number;
    /**
     * Optional prior tool-log entries written to cache/tool-log.jsonl BEFORE
     * session-start fires. Use this to reproduce live behavior for rules that
     * read the session tool log (e.g. drift-detect's repetition heuristic,
     * force-check-required's denial cache). Each entry may omit `ts` and `ms`
     * -- the harness supplies monotonic defaults so older entries are older.
     */
    toolLog?: Array<{
      ts?: number;
      tool: string;
      toolUseId?: string;
      batchPosition?: number;
      batchSize?: number;
      path?: string;
      cmd?: string;
      status: string;
      gate: string;
      reason?: string;
      ms?: number;
    }>;
    /**
     * Optional graduated drift-block state keyed by absolute target path. Use
     * this to reproduce post-nudge / thrashing-message transitions without
     * replaying the whole prior-denial history — seed `level` directly.
     */
    driftState?: Record<
      string,
      {
        level: 0 | 1 | 2 | 3;
        allowedSinceLevelChange: number;
      }
    >;
    /**
     * Optional plan-file materialization. When set, the harness writes
     * `<scenario run>/plans/<slug>.md` with `content` BEFORE session-start
     * fires, stamps `slug: <slug>` onto the first synthesized JSONL transcript
     * line so adapter plan-source lookup can find it, and unlinks the file in
     * the run's `finally` block. Slug uniqueness is the scenario author's
     * responsibility — convention is to include the scenario fixture's
     * filename root.
     */
    planFile?: { slug: string; content: string };
  };
}

/**
 * Per-fire result inside a fan-out `ScenarioResult`. Each entry is one
 * PreToolUse hook invocation against one sub-line in the final
 * `assistant_split`.
 */
export interface FanoutFireResult {
  position: number;
  tool_use_id: string;
  decision: string;
  gate?: string;
  reason?: string;
  ms: number;
  expected?: string;
  gate_expected?: string;
  pass: boolean;
  asserted: boolean;
  /** Per-clause results when `expect[k].reason_must` was scored on this fire. */
  reason_must_results?: ReasonMustResult[];
  /**
   * Hook's raw reason string verbatim. For PreToolUse/PostToolUse this is the
   * gate-attributed `gateReason` from `tool-log.jsonl`; for Stop hooks it is
   * `tlReason` from the hook's stdout JSON. Differs from the existing
   * overloaded `reason` (which carries scoring-failure messages OR hook
   * reason) because per-hook-kind dispatch is non-obvious.
   */
  actual_reason?: string;
  /** Echoed env.llm_stubs for reproducibility. */
  llm_stubs_used?: Record<string, string>;
}

/**
 * Per-assertion result inside ScenarioResult.prediction_assertions. One entry
 * per filter the scenario specified.
 */
export interface PredictionAssertionResult {
  kind:
    | "must_block"
    | "must_not_block"
    | "must_be_empty"
    | "must_have_mood"
    | "must_have_trust"
    | "must_not_have_mood"
    | "must_not_have_trust"
    | "intent_must_contain";
  filter?: { tool?: string; target_substring?: string };
  pass: boolean;
  reason?: string;
}

/**
 * Result of running a scenario — written to report-scenario.json and
 * echoed to stdout by test-harness/scenario.ts.
 */
export type ScenarioResult =
  | {
      mode: "single";
      scenario: string;
      hook: HookEventName;
      decision: string;
      gate?: string;
      gate_expected?: string;
      reason?: string;
      expected: string;
      pass: boolean;
      ms: number;
      error?: string;
      transcript_path: string;
      commit: string;
      /** Echoed from target.batch_visible_through for reproducibility. */
      batch_visible_through?: number;
      /** Per-assertion results when scenario.predictions was set. */
      prediction_assertions?: PredictionAssertionResult[];
      /** Per-clause results when scenario.expect.reason_must was scored. */
      reason_must_results?: ReasonMustResult[];
      /**
       * Hook's raw reason string verbatim. PreToolUse/PostToolUse: the
       * gate-attributed `gateReason` from `tool-log.jsonl`. Stop hook:
       * `tlReason` from the hook's stdout JSON. Per-hook-kind divergence is
       * the WHY this is a separate field from the overloaded `reason`.
       */
      actual_reason?: string;
      injection_assertions?: Array<{
        id: string;
        trigger: string;
        channel: "context";
        message_hash: string;
        pass: boolean;
        reason?: string;
      }>;
      context_output_hash?: string | null;
      context_output_pass?: boolean;
      /** Echoed scenario.env.llm_stubs for reproducibility. */
      llm_stubs_used?: Record<string, string>;
      /**
       * Reality of this run relative to where the fixture lives:
       * - `"expected-to-pass"` when pass === true (fixture in expected-to-pass/ matched)
       * - `"fixture-bug"` when pass === false and fixture is NOT in expected-to-fail/
       * - `"expected-to-fail"` when pass === false and fixture IS in expected-to-fail/
       * - `null` for home-source scenarios on failure (no folder context)
       * Written to last-run.json sidecar, NOT back to the fixture file.
       */
      expectation_reality: "expected-to-pass" | "fixture-bug" | "expected-to-fail" | null;
      /** ISO-8601 UTC timestamp of this run's reality. */
      expectation_reality_last_run_at: string;
    }
  | {
      mode: "fanout";
      scenario: string;
      hook: HookEventName;
      fires: FanoutFireResult[];
      pass: boolean;
      ms: number;
      error?: string;
      transcript_path: string;
      commit: string;
      /** Per-assertion results when scenario.predictions was set. */
      prediction_assertions?: PredictionAssertionResult[];
      /** Echoed scenario.env.llm_stubs for reproducibility. */
      llm_stubs_used?: Record<string, string>;
      /**
       * Reality of this run relative to where the fixture lives:
       * - `"expected-to-pass"` when pass === true
       * - `"fixture-bug"` when pass === false and not in expected-to-fail/
       * - `"expected-to-fail"` when pass === false and in expected-to-fail/
       * - `null` for home-source scenarios on failure
       * Written to last-run.json sidecar, NOT back to the fixture file.
       */
      expectation_reality: "expected-to-pass" | "fixture-bug" | "expected-to-fail" | null;
      /** ISO-8601 UTC timestamp of this run's reality. */
      expectation_reality_last_run_at: string;
    };

/**
 * Validate a raw JSON value as a Scenario. Throws descriptive errors on
 * malformed input. Enforces the per-hook `expected` vocabulary and
 * explicitly rejects `expect.at` (which zod would silently drop).
 */
export function validateScenario(raw: unknown): Scenario {
  if (!raw || typeof raw !== "object") {
    throw new Error("scenario must be an object");
  }
  const r = raw as Record<string, unknown>;

  if (r.schema_version !== 1 && r.schema_version !== 2) {
    throw new Error(
      `scenario.schema_version must be 1 or 2, got ${JSON.stringify(r.schema_version)}`,
    );
  }
  if (typeof r.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.name)) {
    throw new Error(
      `scenario.name must match [A-Za-z0-9._-]+, got ${JSON.stringify(r.name)}`,
    );
  }
  if ("expectation_reality" in r || "expectation_reality_last_run_at" in r) {
    throw new Error(
      "scenario fixture must not contain expectation_reality / expectation_reality_last_run_at — those live in last-run.json",
    );
  }
  if (r.description !== undefined && typeof r.description !== "string") {
    throw new Error("scenario.description must be a string when set");
  }
  if (!Array.isArray(r.transcript) || r.transcript.length === 0) {
    throw new Error("scenario.transcript must be a non-empty array");
  }
  for (let i = 0; i < r.transcript.length; i++) {
    const e = r.transcript[i] as Record<string, unknown>;
    if (!e || (e.role !== "user" && e.role !== "assistant" && e.role !== "assistant_split")) {
      throw new Error(
        `scenario.transcript[${i}].role must be "user", "assistant", or "assistant_split"`,
      );
    }
    if (e.role === "user" || e.role === "assistant") {
      if (e.content === undefined) {
        throw new Error(`scenario.transcript[${i}].content is required`);
      }
      if (e.role === "assistant" && !Array.isArray(e.content)) {
        throw new Error(
          `scenario.transcript[${i}].content must be an array of blocks for assistant entries`,
        );
      }
      if (e.role === "user" && e.isMeta !== undefined && typeof e.isMeta !== "boolean") {
        throw new Error(
          `scenario.transcript[${i}].isMeta must be a boolean when set`,
        );
      }
    } else {
      // assistant_split
      if (typeof e.msg_id !== "string" || e.msg_id.length === 0) {
        throw new Error(
          `scenario.transcript[${i}].msg_id must be a non-empty string for assistant_split entries`,
        );
      }
      if (!Array.isArray(e.lines) || e.lines.length === 0) {
        throw new Error(
          `scenario.transcript[${i}].lines must be a non-empty array for assistant_split entries`,
        );
      }
      for (let j = 0; j < e.lines.length; j++) {
        const ln = (e.lines as Array<Record<string, unknown>>)[j];
        if (!ln || !Array.isArray(ln.blocks)) {
          throw new Error(
            `scenario.transcript[${i}].lines[${j}].blocks must be an array`,
          );
        }
      }
    }
  }

  const target = r.target as Record<string, unknown> | undefined;
  if (!target || typeof target !== "object") {
    throw new Error("scenario.target is required");
  }
  const validHooks: HookEventName[] = [
    "PreToolUse",
    "PostToolUse",
    "Stop",
    "UserPromptSubmit",
    "SessionStart",
    "PostToolUseFailure",
  ];
  if (!validHooks.includes(target.hook as HookEventName)) {
    throw new Error(
      `scenario.target.hook must be one of ${validHooks.join(", ")}, got ${JSON.stringify(target.hook)}`,
    );
  }
  const hook = target.hook as HookEventName;

  // Collect all tool_use blocks from the final entry, whether it's a
  // normal assistant entry or a split-message assistant_split entry.
  function collectFinalAssistantBlocks(
    last: Record<string, unknown>,
  ): ScenarioBlock[] | null {
    if (last.role === "assistant" && Array.isArray(last.content)) {
      return last.content as ScenarioBlock[];
    }
    if (last.role === "assistant_split" && Array.isArray(last.lines)) {
      const out: ScenarioBlock[] = [];
      for (const ln of last.lines as Array<{ blocks: ScenarioBlock[] }>) {
        out.push(...ln.blocks);
      }
      return out;
    }
    return null;
  }

  const fanout = (target as { fanout?: unknown }).fanout;
  if (fanout !== undefined && typeof fanout !== "boolean") {
    throw new Error("scenario.target.fanout must be a boolean when set");
  }

  // ── Fan-out branch (F1..F7). When target.fanout === true we run the
  // fan-out rule set and skip both the B1..B7 branch and the single-form
  // expect-object validation further down.
  if (fanout === true) {
    // F1: hook must be PreToolUse.
    if (hook !== "PreToolUse") {
      throw new Error(
        `scenario.target.fanout=true requires hook=PreToolUse, got ${hook}`,
      );
    }
    // F2/F3: mutually exclusive with tool_use_ref / batch_visible_through.
    if ((target as { tool_use_ref?: unknown }).tool_use_ref !== undefined) {
      throw new Error(
        "scenario.target.fanout=true is mutually exclusive with tool_use_ref",
      );
    }
    if (
      (target as { batch_visible_through?: unknown }).batch_visible_through !==
      undefined
    ) {
      throw new Error(
        "scenario.target.fanout=true is mutually exclusive with batch_visible_through",
      );
    }
    // F4: final entry must be assistant_split.
    const last = r.transcript[r.transcript.length - 1] as Record<
      string,
      unknown
    >;
    if (last.role !== "assistant_split" || !Array.isArray(last.lines)) {
      throw new Error(
        "scenario.target.fanout=true requires the final transcript entry to be role=assistant_split",
      );
    }
    const splitLines = last.lines as Array<{ blocks: ScenarioBlock[] }>;
    // F5: compute firstToolUseIdx. Sub-lines [0..firstToolUseIdx-1] may
    // carry exactly one text or thinking block. Sub-lines
    // [firstToolUseIdx..end] must each contain exactly one tool_use block.
    let firstToolUseIdx = -1;
    for (let j = 0; j < splitLines.length; j++) {
      const blocks = splitLines[j].blocks;
      if (blocks.length === 1 && blocks[0].type === "tool_use") {
        firstToolUseIdx = j;
        break;
      }
      if (
        blocks.length === 1 &&
        (blocks[0].type === "text" || blocks[0].type === "thinking")
      ) {
        continue;
      }
      throw new Error(
        `scenario.transcript[${r.transcript.length - 1}].lines[${j}] must contain exactly one text/thinking block (before any tool_use) or one tool_use block under fanout`,
      );
    }
    if (firstToolUseIdx === -1) {
      throw new Error(
        "scenario.target.fanout=true requires at least one tool_use sub-line in the final assistant_split",
      );
    }
    for (let j = firstToolUseIdx; j < splitLines.length; j++) {
      const blocks = splitLines[j].blocks;
      if (blocks.length !== 1 || blocks[0].type !== "tool_use") {
        throw new Error(
          `scenario.transcript[${r.transcript.length - 1}].lines[${j}] must contain exactly one tool_use block (no text/thinking interleaved after the first tool_use sub-line under fanout)`,
        );
      }
    }
    const toolUseCount = splitLines.length - firstToolUseIdx;
    if (toolUseCount < 2) {
      throw new Error(
        "scenario.target.fanout=true requires at least 2 tool_use sub-lines; use single-hook mode for a batch of 1",
      );
    }
    // F6: ids are either explicit or will be synthesized by materializeBlocks.
    // No hard id requirement on the author.

    // F7: expect must be the array form.
    const expectRaw = r.expect;
    if (!Array.isArray(expectRaw)) {
      throw new Error(
        "scenario.expect must be the array form when target.fanout=true",
      );
    }
    if (expectRaw.length === 0) {
      throw new Error(
        "scenario.expect (array form) must have at least one entry",
      );
    }
    const preVocab = ["allow", "deny"];
    const seenPositions = new Set<number>();
    for (let k = 0; k < expectRaw.length; k++) {
      const e = expectRaw[k] as Record<string, unknown>;
      if (!e || typeof e !== "object") {
        throw new Error(`scenario.expect[${k}] must be an object`);
      }
      if (
        typeof e.position !== "number" ||
        !Number.isInteger(e.position) ||
        e.position < 0
      ) {
        throw new Error(
          `scenario.expect[${k}].position must be a non-negative integer`,
        );
      }
      if (e.position < firstToolUseIdx || e.position >= splitLines.length) {
        throw new Error(
          `scenario.expect[${k}].position (${e.position}) must be in [${firstToolUseIdx}, ${splitLines.length - 1}]`,
        );
      }
      if (seenPositions.has(e.position)) {
        throw new Error(
          `scenario.expect[${k}].position (${e.position}) is duplicated`,
        );
      }
      seenPositions.add(e.position);
      if (typeof e.expected !== "string") {
        throw new Error(`scenario.expect[${k}].expected must be a string`);
      }
      if (!preVocab.includes(e.expected)) {
        throw new Error(
          `scenario.expect[${k}].expected must be one of ${preVocab.join(", ")}, got ${JSON.stringify(e.expected)}`,
        );
      }
      if (e.by !== undefined && typeof e.by !== "string") {
        throw new Error(
          `scenario.expect[${k}].by must be a string when set`,
        );
      }
      if (e.notes !== undefined && typeof e.notes !== "string") {
        throw new Error(
          `scenario.expect[${k}].notes must be a string when set`,
        );
      }
      if (e.prediction !== undefined) {
        validateExpectPredictionAnnotation(
          `scenario.expect[${k}]`,
          e.expected as string,
          e.by as string | undefined,
          e.prediction,
        );
      }
      if (e.reason_must !== undefined) {
        if (e.expected !== "deny" && e.expected !== "block") {
          throw new Error(
            `scenario.expect[${k}].reason_must requires expected ∈ {"deny","block"}, got ${JSON.stringify(e.expected)}`,
          );
        }
        validateReasonMustExpectation(`scenario.expect[${k}]`, e.reason_must);
      }
    }

    // env block still validates below via the shared code path.
    // Single-form expect-object check below is skipped for fanout.
  }

  // For PreToolUse / PostToolUse: the final entry must be an assistant
  // (or assistant_split) with at least one tool_use block, and
  // tool_use_ref (if a specific id) must match one of them.
  if (fanout !== true && (hook === "PreToolUse" || hook === "PostToolUse")) {
    const last = r.transcript[r.transcript.length - 1] as Record<string, unknown>;
    const blocks = collectFinalAssistantBlocks(last);
    if (!blocks) {
      throw new Error(
        `scenario.target.hook=${hook} requires the final transcript entry to be an assistant (or assistant_split) with content blocks`,
      );
    }
    const toolUses = blocks.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) {
      throw new Error(
        `scenario.target.hook=${hook} requires at least one tool_use block in the final assistant entry`,
      );
    }
    const ref = target.tool_use_ref;
    if (ref !== undefined && ref !== "last" && typeof ref !== "string") {
      throw new Error(
        'scenario.target.tool_use_ref must be "last" or a tool_use id string',
      );
    }
    if (typeof ref === "string" && ref !== "last") {
      const found = toolUses.find(
        (b) => (b as { id?: string }).id === ref,
      );
      if (!found) {
        throw new Error(
          `scenario.target.tool_use_ref "${ref}" does not match any tool_use block id in the final assistant entry`,
        );
      }
    }

    // Rule 7 (B7): reject interleaved text/thinking sub-lines between
    // tool_use sub-lines inside the final assistant_split. Real Claude
    // Code never writes this shape, and detectParallelBatch's back-walk
    // at src/utils/transcript.ts:1127 breaks on text-only assistant
    // lines, which would orphan tool_uses on one side. Thinking-only
    // sub-lines strictly before all tool_use sub-lines are fine
    // because the back-walk skips them.
    if (last.role === "assistant_split" && Array.isArray(last.lines)) {
      const splitLines = last.lines as Array<{ blocks: ScenarioBlock[] }>;
      let sawToolUse = false;
      for (let j = 0; j < splitLines.length; j++) {
        const ln = splitLines[j];
        const hasToolUse = ln.blocks.some((b) => b.type === "tool_use");
        const hasText = ln.blocks.some((b) => b.type === "text");
        if (hasToolUse) {
          sawToolUse = true;
          continue;
        }
        if (sawToolUse && hasText) {
          throw new Error(
            `scenario.transcript[${r.transcript.length - 1}].lines[${j}] has a text block after a tool_use sub-line; text/thinking must occur strictly before any tool_use sub-line in an assistant_split`,
          );
        }
      }
    }

    // batch_visible_through rules (B1..B6).
    const cap = (target as { batch_visible_through?: unknown })
      .batch_visible_through;
    if (cap !== undefined) {
      if (typeof cap !== "number" || !Number.isInteger(cap) || cap < 0) {
        throw new Error(
          "scenario.target.batch_visible_through must be a non-negative integer",
        );
      }
      if (last.role !== "assistant_split") {
        throw new Error(
          "scenario.target.batch_visible_through requires the final transcript entry to be role=assistant_split (byte-indistinguishability from real Claude Code parallel batches)",
        );
      }
      const splitLines = (last.lines as Array<{ blocks: ScenarioBlock[] }>);
      if (cap >= splitLines.length) {
        throw new Error(
          `scenario.target.batch_visible_through (${cap}) must be < final assistant_split.lines.length (${splitLines.length})`,
        );
      }
      if (ref === undefined) {
        throw new Error(
          "scenario.target.tool_use_ref is required when batch_visible_through is set (default 'last' is ambiguous under truncation)",
        );
      }
      if (ref === "last") {
        throw new Error(
          'scenario.target.tool_use_ref="last" is not allowed when batch_visible_through is set; use the concrete tool_use id',
        );
      }
      // ref is a concrete id string. Verify it points to a tool_use in
      // the visible slice of the FINAL assistant_split (rule B6).
      let foundInVisibleSlice = false;
      for (let j = 0; j <= cap; j++) {
        const ln = splitLines[j];
        for (const b of ln.blocks) {
          if (b.type === "tool_use" && (b as { id?: string }).id === ref) {
            foundInVisibleSlice = true;
            break;
          }
        }
        if (foundInVisibleSlice) break;
      }
      if (!foundInVisibleSlice) {
        throw new Error(
          `scenario.target.tool_use_ref "${ref}" must point to a tool_use in final assistant_split.lines[0..${cap}]; batch_visible_through applies only to the final entry's flush state`,
        );
      }
    }
  }

  if (hook === "Stop") {
    const last = r.transcript[r.transcript.length - 1] as Record<string, unknown>;
    if (last.role !== "assistant" && last.role !== "assistant_split") {
      throw new Error(
        "scenario.target.hook=Stop requires the final transcript entry to be an assistant",
      );
    }
    const blocks = collectFinalAssistantBlocks(last);
    if (blocks && blocks.some((b) => b.type === "tool_use")) {
      throw new Error(
        "scenario.target.hook=Stop requires the final assistant entry to have no tool_use blocks",
      );
    }
  }

  if (hook === "UserPromptSubmit") {
    const last = r.transcript[r.transcript.length - 1] as Record<string, unknown>;
    if (last.role !== "user") {
      throw new Error(
        "scenario.target.hook=UserPromptSubmit requires the final transcript entry to be a user message",
      );
    }
  }

  const env = r.env as Record<string, unknown> | undefined;
  if (env !== undefined) {
    if (typeof env !== "object" || env === null) {
      throw new Error("scenario.env must be an object when set");
    }
    if (env.permission_mode !== undefined) {
      const validModes: PermissionMode[] = [
        "default",
        "plan",
        "acceptEdits",
        "bypassPermissions",
        "dontAsk",
      ];
      if (!validModes.includes(env.permission_mode as PermissionMode)) {
        throw new Error(
          `scenario.env.permission_mode must be one of ${validModes.join(", ")}`,
        );
      }
    }
    if (env.session_start_permission_mode !== undefined) {
      const validModes: PermissionMode[] = [
        "default",
        "plan",
        "acceptEdits",
        "bypassPermissions",
        "dontAsk",
      ];
      if (!validModes.includes(env.session_start_permission_mode as PermissionMode)) {
        throw new Error(
          `scenario.env.session_start_permission_mode must be one of ${validModes.join(", ")}`,
        );
      }
    }
    if (env.cwd !== undefined && typeof env.cwd !== "string") {
      throw new Error("scenario.env.cwd must be a string");
    }
    if (env.timeout_ms !== undefined && typeof env.timeout_ms !== "number") {
      throw new Error("scenario.env.timeout_ms must be a number");
    }
    if (env.adapter !== undefined) {
      if (typeof env.adapter !== "string") {
        throw new Error("scenario.env.adapter must be a string when set");
      }
      const known = registeredAdapterNames();
      if (!known.includes(env.adapter as string)) {
        throw new Error(
          `scenario.env.adapter "${env.adapter}" is not a registered adapter (known: ${known.join(", ")})`,
        );
      }
    }
    if (env.codex_collaboration_mode !== undefined && env.codex_collaboration_mode !== "plan") {
      throw new Error('scenario.env.codex_collaboration_mode must be "plan" when set');
    }
    if (env.llm_stubs !== undefined) {
      validateLlmStubs(env.llm_stubs);
    }
  }

  validateSetupFiles(r);
  validateSeedSidecars(r);
  validateScenarioSeedState(r);

  if (fanout === true) {
    // Fan-out already validated its own array-form expect above. Skip the
    // single-form validation entirely. Still validate the optional
    // `predictions` block at the bottom of this function.
    validateScenarioPredictions(r);
    return raw as Scenario;
  }

  const expect = r.expect as Record<string, unknown> | undefined;
  if (Array.isArray(expect)) {
    throw new Error(
      "scenario.expect array form is only valid when target.fanout=true",
    );
  }
  if (!expect || typeof expect !== "object") {
    throw new Error("scenario.expect is required");
  }
  if (typeof expect.expected !== "string") {
    throw new Error("scenario.expect.expected must be a string");
  }
  if ("at" in expect) {
    throw new Error(
      "scenario.expect.at is not allowed — scenarios always run against the full file state",
    );
  }
  // Per-hook vocabulary enforcement.
  const vocab: Record<HookEventName, string[]> = {
    PreToolUse: ["allow", "deny"],
    PostToolUse: ["ok", "error"],
    Stop: ["pass", "block"],
    UserPromptSubmit: ["ok", "error"],
    SessionStart: ["ok", "error"],
    PostToolUseFailure: ["ok", "error"],
  };
  if (!vocab[hook].includes(expect.expected as string)) {
    throw new Error(
      `scenario.expect.expected for hook ${hook} must be one of ${vocab[hook].join(", ")}, got ${JSON.stringify(expect.expected)}`,
    );
  }
  if (expect.by !== undefined && typeof expect.by !== "string") {
    throw new Error("scenario.expect.by must be a string when set");
  }
  if (expect.notes !== undefined && typeof expect.notes !== "string") {
    throw new Error("scenario.expect.notes must be a string when set");
  }
  if (expect.prediction !== undefined) {
    validateExpectPredictionAnnotation(
      "scenario.expect",
      expect.expected as string,
      expect.by as string | undefined,
      expect.prediction,
    );
  }
  if (expect.reason_must !== undefined) {
    if (expect.expected !== "deny" && expect.expected !== "block") {
      throw new Error(
        `scenario.expect.reason_must requires expected ∈ {"deny","block"}, got ${JSON.stringify(expect.expected)}`,
      );
    }
    validateReasonMustExpectation("scenario.expect", expect.reason_must);
  }
  validateInjectionExpectations("scenario.expect", expect);
  if (expect.context_output_hash !== undefined && typeof expect.context_output_hash !== "string") {
    throw new Error("scenario.expect.context_output_hash must be a string when set");
  }

  validateScenarioPredictions(r);

  return raw as Scenario;
}

function validateSetupFiles(r: Record<string, unknown>): void {
  if (r.setup_files === undefined) return;
  if (!Array.isArray(r.setup_files)) {
    throw new Error("scenario.setup_files must be an array when set");
  }
  for (let i = 0; i < r.setup_files.length; i++) {
    const file = r.setup_files[i] as Record<string, unknown>;
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      throw new Error(`scenario.setup_files[${i}] must be an object`);
    }
    if (typeof file.path !== "string" || file.path.length === 0) {
      throw new Error(`scenario.setup_files[${i}].path must be a non-empty string`);
    }
    const segments = file.path.split(/[\\/]+/);
    if (file.path.startsWith("/") || segments.includes("..")) {
      throw new Error(`scenario.setup_files[${i}].path must be relative and must not contain parent references`);
    }
    if (typeof file.content !== "string") {
      throw new Error(`scenario.setup_files[${i}].content must be a string`);
    }
  }
}

function validateSeedSidecars(r: Record<string, unknown>): void {
  if (r.seed_sidecars === undefined) return;
  if (!r.seed_sidecars || typeof r.seed_sidecars !== "object" || Array.isArray(r.seed_sidecars)) {
    throw new Error("scenario.seed_sidecars must be an object when set");
  }
  const sidecars = r.seed_sidecars as Record<string, unknown>;
  if (sidecars.plan_mode_state !== undefined && sidecars.plan_mode_state !== null) {
    validatePlanModeStoredState("scenario.seed_sidecars.plan_mode_state", sidecars.plan_mode_state);
  }
  if (sidecars.injections !== undefined) {
    if (!Array.isArray(sidecars.injections)) {
      throw new Error("scenario.seed_sidecars.injections must be an array when set");
    }
    for (let i = 0; i < sidecars.injections.length; i++) {
      validateInjectionRecord(`scenario.seed_sidecars.injections[${i}]`, sidecars.injections[i]);
    }
  }
}

function validatePlanModeStoredState(ctx: string, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ctx} must be an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.active !== "boolean") throw new Error(`${ctx}.active must be a boolean`);
  if (typeof s.updatedAt !== "number") throw new Error(`${ctx}.updatedAt must be a number`);
  if (s.lastSource !== "SessionStart" && s.lastSource !== "UserPromptSubmit") {
    throw new Error(`${ctx}.lastSource must be SessionStart or UserPromptSubmit`);
  }
  if (s.mode !== null && typeof s.mode !== "string") {
    throw new Error(`${ctx}.mode must be a string or null`);
  }
  if (
    s.detection_source !== "codex-collaboration-mode" &&
    s.detection_source !== "hook-permission-mode" &&
    s.detection_source !== "transcript-permission-mode" &&
    s.detection_source !== "none"
  ) {
    throw new Error(`${ctx}.detection_source must be a valid plan-mode detector source`);
  }
  if (s.deliveredPlansMdHash !== undefined && s.deliveredPlansMdHash !== null && typeof s.deliveredPlansMdHash !== "string") {
    throw new Error(`${ctx}.deliveredPlansMdHash must be a string or null`);
  }
  if (s.deliveredPlansMdAt !== undefined && s.deliveredPlansMdAt !== null && typeof s.deliveredPlansMdAt !== "number") {
    throw new Error(`${ctx}.deliveredPlansMdAt must be a number or null`);
  }
}

function validateInjectionRecord(ctx: string, raw: unknown): void {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${ctx} must be an object`);
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.seq !== "number") throw new Error(`${ctx}.seq must be a number`);
  if (typeof r.ts !== "number") throw new Error(`${ctx}.ts must be a number`);
  if (typeof r.id !== "string") throw new Error(`${ctx}.id must be a string`);
  if (typeof r.trigger !== "string") throw new Error(`${ctx}.trigger must be a string`);
  if (r.channel !== "context") throw new Error(`${ctx}.channel must be context`);
  if (typeof r.message !== "string") throw new Error(`${ctx}.message must be a string`);
  if (typeof r.message_hash !== "string") throw new Error(`${ctx}.message_hash must be a string`);
  if (typeof r.event !== "string") throw new Error(`${ctx}.event must be a string`);
}

function validateInjectionExpectations(ctx: string, raw: Record<string, unknown>): void {
  if (raw.injections === undefined) return;
  if (!Array.isArray(raw.injections)) {
    throw new Error(`${ctx}.injections must be an array when set`);
  }
  for (let i = 0; i < raw.injections.length; i++) {
    const item = raw.injections[i] as Record<string, unknown>;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(`${ctx}.injections[${i}] must be an object`);
    }
    if (typeof item.id !== "string") throw new Error(`${ctx}.injections[${i}].id must be a string`);
    if (typeof item.trigger !== "string") throw new Error(`${ctx}.injections[${i}].trigger must be a string`);
    if (item.channel !== "context") throw new Error(`${ctx}.injections[${i}].channel must be context`);
    if (typeof item.message_hash !== "string") {
      throw new Error(`${ctx}.injections[${i}].message_hash must be a string`);
    }
    if (item.message !== undefined && typeof item.message !== "string") {
      throw new Error(`${ctx}.injections[${i}].message must be a string when set`);
    }
  }
}

/**
 * Validate a `prediction` annotation on a single-form or fanout-form expect
 * entry. Mirrors the rules in test-harness-shared.ts:validatePredictionAnnotation.
 */
function validateExpectPredictionAnnotation(
  ctx: string,
  expected: string,
  by: string | undefined,
  prediction: unknown,
): void {
  if (!prediction || typeof prediction !== "object") {
    throw new Error(`${ctx}.prediction must be an object when set`);
  }
  const p = prediction as Record<string, unknown>;
  if (expected !== "deny") {
    throw new Error(
      `${ctx}.prediction requires expected="deny", got ${JSON.stringify(expected)}`,
    );
  }
  if (by !== "prediction-block" && by !== "batch-sibling") {
    throw new Error(
      `${ctx}.prediction requires by ∈ {"prediction-block","batch-sibling"}, got ${JSON.stringify(by)}`,
    );
  }
  const validVerdicts = ["correct", "too_broad", "wrong", "INVESTIGATE"];
  if (typeof p.verdict !== "string" || !validVerdicts.includes(p.verdict)) {
    throw new Error(
      `${ctx}.prediction.verdict must be one of ${validVerdicts.join(", ")}, got ${JSON.stringify(p.verdict)}`,
    );
  }
  if (p.verdict === "too_broad") {
    if (!Array.isArray(p.forbidden_blocks) || p.forbidden_blocks.length === 0) {
      throw new Error(
        `${ctx}.prediction.forbidden_blocks must be a non-empty array when verdict="too_broad"`,
      );
    }
  }
  if (p.intent_must_contain !== undefined) {
    if (typeof p.intent_must_contain !== "string" || p.intent_must_contain.length === 0) {
      throw new Error(
        `${ctx}.prediction.intent_must_contain must be a non-empty string when set`,
      );
    }
  }
  if (p.expected_mood !== undefined) {
    const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
    if (typeof p.expected_mood !== "string" || !validMoods.includes(p.expected_mood as string)) {
      throw new Error(
        `${ctx}.prediction.expected_mood must be one of ${validMoods.join(", ")}, got ${JSON.stringify(p.expected_mood)}`,
      );
    }
  }
  if (p.expected_trust !== undefined) {
    const validTrusts = ["low", "normal", "high"];
    if (typeof p.expected_trust !== "string" || !validTrusts.includes(p.expected_trust as string)) {
      throw new Error(
        `${ctx}.prediction.expected_trust must be one of ${validTrusts.join(", ")}, got ${JSON.stringify(p.expected_trust)}`,
      );
    }
  }
}

/**
 * Validate the required `scenario.seed_state` block. Single-hook mode does
 * not fire UserPromptSubmit before the target hook, so every scenario must
 * declare the full prior-turn session state explicitly. All four top-level
 * fields are required; `currentPrediction` must carry every required
 * `ToolPrediction` field (mood, trust, intent, blockedIntent,
 * explicitlyAllowedTools, explicitlyBlockedSubstrings, userMessageSnippet).
 * `timestamp` is the sole optional slot — the runner fills it with
 * `Date.now()` when omitted. Unknown fields are rejected.
 */
function validateScenarioSeedState(r: Record<string, unknown>): void {
  const seed = r.seed_state;
  if (seed === undefined) {
    throw new Error(
      "scenario.seed_state is required — every scenario must declare the full prior-turn session state (currentPrediction, forceCheckPending, frustrationStreak, currentWindowSize)",
    );
  }
  if (typeof seed !== "object" || seed === null || Array.isArray(seed)) {
    throw new Error("scenario.seed_state must be a non-null object");
  }
  const s = seed as Record<string, unknown>;
  const requiredTopFields = [
    "currentPrediction",
    "forceCheckPending",
    "frustrationStreak",
    "currentWindowSize",
  ];
  const optionalTopFields = ["toolLog", "driftState", "planFile"];
  for (const k of requiredTopFields) {
    if (s[k] === undefined) {
      throw new Error(`scenario.seed_state.${k} is required`);
    }
  }
  for (const k of Object.keys(s)) {
    if (!requiredTopFields.includes(k) && !optionalTopFields.includes(k)) {
      throw new Error(
        `scenario.seed_state.${k} is not a recognized field (allowed: ${[...requiredTopFields, ...optionalTopFields].join(", ")})`,
      );
    }
  }
  if (s.toolLog !== undefined) {
    validateSeedToolLog(s.toolLog);
  }
  if (s.driftState !== undefined) {
    validateSeedDriftState(s.driftState);
  }
  if (s.planFile !== undefined) {
    validateSeedPlanFile(s.planFile);
  }
  if (typeof s.forceCheckPending !== "boolean") {
    throw new Error("scenario.seed_state.forceCheckPending must be a boolean");
  }
  if (
    typeof s.frustrationStreak !== "number" ||
    !Number.isInteger(s.frustrationStreak) ||
    s.frustrationStreak < 0
  ) {
    throw new Error(
      "scenario.seed_state.frustrationStreak must be a non-negative integer",
    );
  }
  if (
    typeof s.currentWindowSize !== "number" ||
    !Number.isInteger(s.currentWindowSize) ||
    s.currentWindowSize <= 0
  ) {
    throw new Error(
      "scenario.seed_state.currentWindowSize must be a positive integer",
    );
  }
  if (
    typeof s.currentPrediction !== "object" ||
    s.currentPrediction === null ||
    Array.isArray(s.currentPrediction)
  ) {
    throw new Error("scenario.seed_state.currentPrediction must be a non-null object");
  }
  validateSeedCurrentPrediction(s.currentPrediction as Record<string, unknown>);
}

/**
 * Validate every required `ToolPrediction` field on a seeded
 * `currentPrediction` block. `timestamp` is optional (runner defaults to
 * `Date.now()`); all other fields must be explicit.
 */
function validateSeedCurrentPrediction(p: Record<string, unknown>): void {
  const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
  if (typeof p.mood !== "string" || !validMoods.includes(p.mood)) {
    throw new Error(
      `scenario.seed_state.currentPrediction.mood must be one of ${validMoods.join(", ")}, got ${JSON.stringify(p.mood)}`,
    );
  }
  const validTrusts = ["low", "normal", "high"];
  if (typeof p.trust !== "string" || !validTrusts.includes(p.trust)) {
    throw new Error(
      `scenario.seed_state.currentPrediction.trust must be one of ${validTrusts.join(", ")}, got ${JSON.stringify(p.trust)}`,
    );
  }
  if (typeof p.intent !== "string") {
    throw new Error(
      "scenario.seed_state.currentPrediction.intent must be a string (may be empty when the baseline is a fresh session)",
    );
  }
  if (typeof p.blockedIntent !== "string") {
    throw new Error(
      'scenario.seed_state.currentPrediction.blockedIntent must be a string (use "" when the user has not blocked anything)',
    );
  }
  if (!Array.isArray(p.explicitlyAllowedTools)) {
    throw new Error(
      "scenario.seed_state.currentPrediction.explicitlyAllowedTools must be an array (use [] when empty)",
    );
  }
  for (let i = 0; i < p.explicitlyAllowedTools.length; i++) {
    if (typeof p.explicitlyAllowedTools[i] !== "string") {
      throw new Error(
        `scenario.seed_state.currentPrediction.explicitlyAllowedTools[${i}] must be a string`,
      );
    }
  }
  if (!Array.isArray(p.explicitlyBlockedSubstrings)) {
    throw new Error(
      "scenario.seed_state.currentPrediction.explicitlyBlockedSubstrings must be an array (use [] when empty)",
    );
  }
  for (let i = 0; i < p.explicitlyBlockedSubstrings.length; i++) {
    const entry = p.explicitlyBlockedSubstrings[i] as Record<string, unknown> | undefined;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(
        `scenario.seed_state.currentPrediction.explicitlyBlockedSubstrings[${i}] must be an object`,
      );
    }
    if (typeof entry.tool !== "string" || entry.tool.length === 0) {
      throw new Error(
        `scenario.seed_state.currentPrediction.explicitlyBlockedSubstrings[${i}].tool must be a non-empty string`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.length === 0) {
      throw new Error(
        `scenario.seed_state.currentPrediction.explicitlyBlockedSubstrings[${i}].reason must be a non-empty string`,
      );
    }
    if (entry.targetSubstring !== undefined && typeof entry.targetSubstring !== "string") {
      throw new Error(
        `scenario.seed_state.currentPrediction.explicitlyBlockedSubstrings[${i}].targetSubstring must be a string when set`,
      );
    }
  }
  if (typeof p.userMessageSnippet !== "string") {
    throw new Error(
      'scenario.seed_state.currentPrediction.userMessageSnippet must be a string (use "" when there is no prior turn)',
    );
  }
  if (p.blockAllTools !== undefined && typeof p.blockAllTools !== "boolean") {
    throw new Error(
      "scenario.seed_state.currentPrediction.blockAllTools must be a boolean when set",
    );
  }
  if (p.timestamp !== undefined && typeof p.timestamp !== "number") {
    throw new Error(
      "scenario.seed_state.currentPrediction.timestamp must be a number when set",
    );
  }
  const cs = p.contextSwitch;
  if (cs !== undefined && cs !== "yes" && cs !== "no") {
    throw new Error(
      'scenario.seed_state.currentPrediction.contextSwitch must be "yes" or "no" when set',
    );
  }
  const qis = p.questionIsStalling;
  if (qis !== undefined && qis !== "yes" && qis !== "no" && qis !== "n/a") {
    throw new Error(
      'scenario.seed_state.currentPrediction.questionIsStalling must be "yes", "no", or "n/a" when set',
    );
  }
  const knownFields = [
    "mood",
    "trust",
    "intent",
    "blockedIntent",
    "explicitlyAllowedTools",
    "explicitlyBlockedSubstrings",
    "userMessageSnippet",
    "blockAllTools",
    "timestamp",
    "contextSwitch",
    "questionIsStalling",
  ];
  for (const k of Object.keys(p)) {
    if (!knownFields.includes(k)) {
      throw new Error(
        `scenario.seed_state.currentPrediction.${k} is not a recognized field`,
      );
    }
  }
}

/**
 * Validate the optional `scenario.seed_state.toolLog` array. Each entry must
 * match ToolLogEntry shape (see src/utils/session-store.ts) with `ts` and `ms`
 * optional -- the harness fills monotonic defaults when missing.
 */
function validateSeedToolLog(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("scenario.seed_state.toolLog must be an array when set");
  }
  const stringFields = ["tool", "toolUseId", "path", "cmd", "status", "gate", "reason"];
  const numberFields = ["ts", "ms", "batchPosition", "batchSize"];
  const requiredFields = ["tool", "status", "gate"];
  for (let i = 0; i < value.length; i++) {
    const e = value[i];
    if (typeof e !== "object" || e === null || Array.isArray(e)) {
      throw new Error(`scenario.seed_state.toolLog[${i}] must be an object`);
    }
    const row = e as Record<string, unknown>;
    for (const k of requiredFields) {
      if (typeof row[k] !== "string" || (row[k] as string).length === 0) {
        throw new Error(
          `scenario.seed_state.toolLog[${i}].${k} must be a non-empty string`,
        );
      }
    }
    for (const k of stringFields) {
      if (row[k] !== undefined && typeof row[k] !== "string") {
        throw new Error(
          `scenario.seed_state.toolLog[${i}].${k} must be a string when set`,
        );
      }
    }
    for (const k of numberFields) {
      if (row[k] !== undefined && typeof row[k] !== "number") {
        throw new Error(
          `scenario.seed_state.toolLog[${i}].${k} must be a number when set`,
        );
      }
    }
    for (const k of Object.keys(row)) {
      if (!stringFields.includes(k) && !numberFields.includes(k)) {
        throw new Error(
          `scenario.seed_state.toolLog[${i}].${k} is not a recognized ToolLogEntry field`,
        );
      }
    }
  }
}

/**
 * Validate the optional `scenario.seed_state.driftState` map. Keys are target
 * paths; values must carry `level` (0-3) and a non-negative
 * `allowedSinceLevelChange` integer.
 */
function validateSeedDriftState(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "scenario.seed_state.driftState must be an object keyed by target path when set",
    );
  }
  for (const [target, raw] of Object.entries(value)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `scenario.seed_state.driftState[${JSON.stringify(target)}] must be an object`,
      );
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.level !== "number" ||
      !Number.isInteger(entry.level) ||
      entry.level < 0 ||
      entry.level > 3
    ) {
      throw new Error(
        `scenario.seed_state.driftState[${JSON.stringify(target)}].level must be an integer 0-3`,
      );
    }
    if (
      typeof entry.allowedSinceLevelChange !== "number" ||
      !Number.isInteger(entry.allowedSinceLevelChange) ||
      entry.allowedSinceLevelChange < 0
    ) {
      throw new Error(
        `scenario.seed_state.driftState[${JSON.stringify(target)}].allowedSinceLevelChange must be a non-negative integer`,
      );
    }
    for (const k of Object.keys(entry)) {
      if (k !== "level" && k !== "allowedSinceLevelChange") {
        throw new Error(
          `scenario.seed_state.driftState[${JSON.stringify(target)}].${k} is not a recognized field`,
        );
      }
    }
  }
}

/**
 * Validate a `reason_must` block on a single-form or fanout-form expect entry.
 * Each present sub-array (`contains`, `not_contains`, `matches`, `not_matches`)
 * must be a non-empty `string[]` whose entries are non-empty strings;
 * `matches`/`not_matches` strings must compile via `new RegExp`. Empty-shape
 * (every sub-array missing) and unknown sub-fields are rejected.
 */
export function validateReasonMustExpectation(ctx: string, value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${ctx}.reason_must must be a non-null object`);
  }
  const v = value as Record<string, unknown>;
  const knownFields = ["contains", "not_contains", "matches", "not_matches"];
  for (const k of Object.keys(v)) {
    if (!knownFields.includes(k)) {
      throw new Error(
        `${ctx}.reason_must.${k} is not a recognized field (allowed: ${knownFields.join(", ")})`,
      );
    }
  }
  let anyPresent = false;
  for (const field of knownFields) {
    const arr = v[field];
    if (arr === undefined) continue;
    anyPresent = true;
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(
        `${ctx}.reason_must.${field} must be a non-empty array of strings when set`,
      );
    }
    for (let i = 0; i < arr.length; i++) {
      const entry = arr[i];
      if (typeof entry !== "string" || entry.length === 0) {
        throw new Error(
          `${ctx}.reason_must.${field}[${i}] must be a non-empty string`,
        );
      }
      if (field === "matches" || field === "not_matches") {
        try {
          new RegExp(entry);
        } catch (err) {
          throw new Error(
            `${ctx}.reason_must.${field}[${i}] is not a valid regex: ${err instanceof Error ? err.message : String(err)} (note: regex source is unanchored — re.test(reason) is substring-match-like)`,
          );
        }
      }
    }
  }
  if (!anyPresent) {
    throw new Error(
      `${ctx}.reason_must is set but every sub-array is missing — provide at least one of ${knownFields.join(", ")}`,
    );
  }
}

/**
 * Validate the optional `scenario.env.llm_stubs` map. Keys are agent names
 * matching `telemetry.agent`; values are exact stubbed output strings the
 * agent-runner returns in lieu of an LLM call. Both keys and values must be
 * non-empty strings.
 */
function validateLlmStubs(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scenario.env.llm_stubs must be a non-null object when set");
  }
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key.length === 0) {
      throw new Error(
        "scenario.env.llm_stubs keys must be non-empty strings (agent names)",
      );
    }
    if (typeof val !== "string" || val.length === 0) {
      throw new Error(
        `scenario.env.llm_stubs[${JSON.stringify(key)}] must be a non-empty string (the exact stubbed output)`,
      );
    }
  }
}

/**
 * Validate the optional `scenario.seed_state.planFile` block. `slug` must
 * match `[A-Za-z0-9._-]+`; `content` is a string (may be empty); unknown
 * sub-fields are rejected.
 */
function validateSeedPlanFile(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      "scenario.seed_state.planFile must be a non-null object when set",
    );
  }
  const p = value as Record<string, unknown>;
  if (typeof p.slug !== "string" || !/^[A-Za-z0-9._-]+$/.test(p.slug)) {
    throw new Error(
      `scenario.seed_state.planFile.slug must match [A-Za-z0-9._-]+, got ${JSON.stringify(p.slug)}`,
    );
  }
  if (typeof p.content !== "string") {
    throw new Error(
      "scenario.seed_state.planFile.content must be a string (may be empty)",
    );
  }
  for (const k of Object.keys(p)) {
    if (k !== "slug" && k !== "content") {
      throw new Error(
        `scenario.seed_state.planFile.${k} is not a recognized field (allowed: slug, content)`,
      );
    }
  }
}

/**
 * Validate the optional `scenario.predictions` block.
 */
function validateScenarioPredictions(r: Record<string, unknown>): void {
  const predictions = r.predictions as Record<string, unknown> | undefined;
  if (predictions === undefined) return;
  if (typeof predictions !== "object" || predictions === null) {
    throw new Error("scenario.predictions must be an object when set");
  }
  const mustBlock = predictions.must_block as unknown;
  const mustNotBlock = predictions.must_not_block as unknown;
  const mustBeEmpty = predictions.must_be_empty as unknown;
  const mustHaveMood = predictions.must_have_mood as unknown;
  const mustHaveTrust = predictions.must_have_trust as unknown;
  const mustNotHaveMood = predictions.must_not_have_mood as unknown;
  const mustNotHaveTrust = predictions.must_not_have_trust as unknown;
  const intentMustContain = predictions.intent_must_contain as unknown;
  const hasMustBlock = mustBlock !== undefined;
  const hasMustNotBlock = mustNotBlock !== undefined;
  const hasMustBeEmpty = mustBeEmpty !== undefined;
  const hasMustHaveMood = mustHaveMood !== undefined;
  const hasMustHaveTrust = mustHaveTrust !== undefined;
  const hasMustNotHaveMood = mustNotHaveMood !== undefined;
  const hasMustNotHaveTrust = mustNotHaveTrust !== undefined;
  const hasIntentMustContain = intentMustContain !== undefined;
  if (
    !hasMustBlock &&
    !hasMustNotBlock &&
    !hasMustBeEmpty &&
    !hasMustHaveMood &&
    !hasMustHaveTrust &&
    !hasMustNotHaveMood &&
    !hasMustNotHaveTrust &&
    !hasIntentMustContain
  ) {
    throw new Error(
      "scenario.predictions block is set but contains no assertions (must_block / must_not_block / must_be_empty / must_have_mood / must_have_trust / must_not_have_mood / must_not_have_trust / intent_must_contain)",
    );
  }
  if (
    hasMustBeEmpty &&
    (hasMustBlock || hasMustNotBlock || hasMustHaveMood || hasMustHaveTrust || hasMustNotHaveMood || hasMustNotHaveTrust || hasIntentMustContain)
  ) {
    throw new Error(
      "scenario.predictions.must_be_empty is mutually exclusive with all other assertions",
    );
  }
  if (hasMustBeEmpty && typeof mustBeEmpty !== "boolean") {
    throw new Error("scenario.predictions.must_be_empty must be a boolean when set");
  }
  if (hasMustHaveMood) {
    const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
    if (typeof mustHaveMood !== "string" || !validMoods.includes(mustHaveMood as string)) {
      throw new Error(
        `scenario.predictions.must_have_mood must be one of ${validMoods.join(", ")}, got ${JSON.stringify(mustHaveMood)}`,
      );
    }
  }
  if (hasMustHaveTrust) {
    const validTrusts = ["low", "normal", "high"];
    if (typeof mustHaveTrust !== "string" || !validTrusts.includes(mustHaveTrust as string)) {
      throw new Error(
        `scenario.predictions.must_have_trust must be one of ${validTrusts.join(", ")}, got ${JSON.stringify(mustHaveTrust)}`,
      );
    }
  }
  if (hasMustNotHaveMood) {
    const validMoods = ["angry", "frustrated", "neutral", "satisfied", "happy"];
    if (!Array.isArray(mustNotHaveMood) || (mustNotHaveMood as unknown[]).length === 0) {
      throw new Error(
        "scenario.predictions.must_not_have_mood must be a non-empty array when set",
      );
    }
    for (const m of mustNotHaveMood as unknown[]) {
      if (typeof m !== "string" || !validMoods.includes(m)) {
        throw new Error(
          `scenario.predictions.must_not_have_mood entries must each be one of ${validMoods.join(", ")}, got ${JSON.stringify(m)}`,
        );
      }
    }
  }
  if (hasMustNotHaveTrust) {
    const validTrusts = ["low", "normal", "high"];
    if (!Array.isArray(mustNotHaveTrust) || (mustNotHaveTrust as unknown[]).length === 0) {
      throw new Error(
        "scenario.predictions.must_not_have_trust must be a non-empty array when set",
      );
    }
    for (const t of mustNotHaveTrust as unknown[]) {
      if (typeof t !== "string" || !validTrusts.includes(t)) {
        throw new Error(
          `scenario.predictions.must_not_have_trust entries must each be one of ${validTrusts.join(", ")}, got ${JSON.stringify(t)}`,
        );
      }
    }
  }
  if (hasIntentMustContain) {
    if (typeof intentMustContain !== "string" || (intentMustContain as string).length === 0) {
      throw new Error(
        "scenario.predictions.intent_must_contain must be a non-empty string when set",
      );
    }
  }
  const validateFilterArray = (name: string, arr: unknown): void => {
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error(`scenario.predictions.${name} must be a non-empty array when set`);
    }
    for (let i = 0; i < arr.length; i++) {
      const f = arr[i] as Record<string, unknown> | undefined;
      if (!f || typeof f !== "object") {
        throw new Error(`scenario.predictions.${name}[${i}] must be an object`);
      }
      if (typeof f.tool !== "string" || f.tool.length === 0) {
        throw new Error(
          `scenario.predictions.${name}[${i}].tool must be a non-empty literal tool name (no regex metachars)`,
        );
      }
      // Reject regex metacharacters in `tool` to enforce literal semantics.
      if (/[.*|[\]()^$+?\\]/.test(f.tool)) {
        throw new Error(
          `scenario.predictions.${name}[${i}].tool must be a LITERAL tool name without regex metacharacters, got ${JSON.stringify(f.tool)}`,
        );
      }
      if ("target_pattern" in f) {
        throw new Error(
          `scenario.predictions.${name}[${i}].target_pattern was renamed to target_substring (literal substring, not regex)`,
        );
      }
      if (f.target_substring !== undefined) {
        if (typeof f.target_substring !== "string") {
          throw new Error(
            `scenario.predictions.${name}[${i}].target_substring must be a string when set`,
          );
        }
        // target_substring is a LITERAL substring — reject regex metachars.
        if (/[.*|[\]()^$+?\\]/.test(f.target_substring as string)) {
          throw new Error(
            `scenario.predictions.${name}[${i}].target_substring must be a LITERAL substring without regex metacharacters, got ${JSON.stringify(f.target_substring)}`,
          );
        }
      }
    }
  };
  if (hasMustBlock) validateFilterArray("must_block", mustBlock);
  if (hasMustNotBlock) validateFilterArray("must_not_block", mustNotBlock);
}
