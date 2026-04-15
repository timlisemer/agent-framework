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
  /** Scoring spec. Reuses RichExpectation minus `at`. */
  expect: {
    expected: string;
    by?: string;
    notes?: string;
  };
}

/**
 * Result of running a scenario — written to report-scenario.json and
 * echoed to stdout by test-harness/scenario.ts.
 */
export interface ScenarioResult {
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

  // For PreToolUse / PostToolUse: the final entry must be an assistant
  // (or assistant_split) with at least one tool_use block, and
  // tool_use_ref (if a specific id) must match one of them.
  if (hook === "PreToolUse" || hook === "PostToolUse") {
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

  const expect = r.expect as Record<string, unknown> | undefined;
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
