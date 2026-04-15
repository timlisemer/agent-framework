/**
 * Scenario testing types and validator.
 *
 * Lives under src/ (not test-harness/) so src-side MCP handlers can
 * import and validate incoming scenario objects. test-harness/scenario.ts
 * imports from here as well via a relative path.
 *
 * @module scenario-types
 */

/** Which hook a scenario targets. */
export type HookEventName =
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "UserPromptSubmit"
  | "SessionStart";

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

/** Environment / setup flags plumbed into the hook stdin and transcript. */
export interface ScenarioEnv {
  /** Copied verbatim into hook input.permission_mode and onto every
   *  transcript entry's permissionMode field. */
  permission_mode?: PermissionMode;
  /** When true, the materialized transcript filename is prefixed "agent-"
   *  so detectSubagent() returns true via the filename short-circuit. */
  subagent?: boolean;
  /** CLAUDE_PROJECT_DIR / hook cwd. Defaults to the scenario run dir. */
  cwd?: string;
  /** Hook timeout in milliseconds. Defaults to 60000. */
  timeout_ms?: number;
}

/** A complete synthetic test scenario for unit-testing a single hook rule. */
export interface Scenario {
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
      }
    | Array<{
        position: number;
        expected: string;
        by?: string;
        notes?: string;
      }>;
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

  if (typeof r.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(r.name)) {
    throw new Error(
      `scenario.name must match [A-Za-z0-9._-]+, got ${JSON.stringify(r.name)}`,
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
    if (env.subagent !== undefined && typeof env.subagent !== "boolean") {
      throw new Error("scenario.env.subagent must be a boolean");
    }
    if (env.cwd !== undefined && typeof env.cwd !== "string") {
      throw new Error("scenario.env.cwd must be a string");
    }
    if (env.timeout_ms !== undefined && typeof env.timeout_ms !== "number") {
      throw new Error("scenario.env.timeout_ms must be a number");
    }
  }

  if (fanout === true) {
    // Fan-out already validated its own array-form expect above. Skip the
    // single-form validation entirely.
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

  return raw as Scenario;
}
