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

export type ScenarioEntry = ScenarioUserEntry | ScenarioAssistantEntry;

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
    if (!e || (e.role !== "user" && e.role !== "assistant")) {
      throw new Error(
        `scenario.transcript[${i}].role must be "user" or "assistant"`,
      );
    }
    if (e.content === undefined) {
      throw new Error(`scenario.transcript[${i}].content is required`);
    }
    if (e.role === "assistant" && !Array.isArray(e.content)) {
      throw new Error(
        `scenario.transcript[${i}].content must be an array of blocks for assistant entries`,
      );
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

  // For PreToolUse / PostToolUse: the final entry must be an assistant
  // with at least one tool_use block, and tool_use_ref (if a specific id)
  // must match one of them.
  if (hook === "PreToolUse" || hook === "PostToolUse") {
    const last = r.transcript[r.transcript.length - 1] as Record<string, unknown>;
    if (last.role !== "assistant" || !Array.isArray(last.content)) {
      throw new Error(
        `scenario.target.hook=${hook} requires the final transcript entry to be an assistant with content blocks`,
      );
    }
    const toolUses = (last.content as ScenarioBlock[]).filter(
      (b) => b.type === "tool_use",
    );
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
  }

  if (hook === "Stop") {
    const last = r.transcript[r.transcript.length - 1] as Record<string, unknown>;
    if (last.role !== "assistant") {
      throw new Error(
        "scenario.target.hook=Stop requires the final transcript entry to be an assistant",
      );
    }
    if (Array.isArray(last.content)) {
      const hasToolUse = (last.content as ScenarioBlock[]).some(
        (b) => b.type === "tool_use",
      );
      if (hasToolUse) {
        throw new Error(
          "scenario.target.hook=Stop requires the final assistant entry to have no tool_use blocks",
        );
      }
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
