/**
 * Adapter contract — canonical types and the AdapterSpec method interface.
 *
 * Generic code depends ONLY on the types and methods defined here. All
 * adapter-specific wire spellings, path literals, and regexes live inside
 * the adapter implementations under adapters/<name>/.
 *
 * @module adapter/types
 */

export type EventName =
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "Stop"
  | "UserPromptSubmit"
  | "SessionStart"
  | "PostToolUseFailure";

/** Provider-specific stdout shapes. */
export interface AdapterEncoder {
  readonly name: string;           // "claude", "codex", ...
  encodePreToolUseAllow(): EncodedOutput;
  encodePreToolUseDeny(reason: string): EncodedOutput;
  encodePermissionRequestAllow?(): EncodedOutput;
  encodePermissionRequestDeny?(reason: string): EncodedOutput;
  encodePostToolUseBlock?(reason: string): EncodedOutput;
  encodeStopBlock(reason: string): EncodedOutput;
  encodeStopPass(): EncodedOutput;
  encodeOk(event: EventName): EncodedOutput;          // exit-code-only events
  encodeContext(event: EventName, message: string): EncodedOutput;
  encodeError(event: EventName, message: string): EncodedOutput;
  encodeUserPromptSubmitBlock?(reason: string): EncodedOutput;
}

export interface EncodedOutput { stdout: string; exitCode: number; }

export type PlanSourceDescriptor =
  | { kind: "file"; path: string }
  | { kind: "inline"; content: string; source: string };

export type PlanExitDetectionInput =
  | { event: "PreToolUse"; canonicalToolName?: string; rawToolName?: string; toolInput?: unknown }
  | { event: "Stop"; assistantText?: string | null }
  | { event: "UserPromptSubmit"; prompt: string };

export interface PlanSourceLookupInput {
  transcriptPath: string;
  sessionDir?: string;
  assistantText?: string | null;
  prompt?: string;
}

export type PlanModeDetectionSource =
  | "codex-collaboration-mode"
  | "hook-permission-mode"
  | "transcript-permission-mode"
  | "none";

export interface PlanModeDetectionInput {
  permissionMode?: string;
  collaborationMode?: string;
  transcriptPath?: string;
}

export interface PlanModeDetection {
  active: boolean;
  mode: string | null;
  source: PlanModeDetectionSource;
}

// ── Canonical names ─────────────────────────────────────────────────────────

export type CanonicalMcp =
  | "check" | "commit" | "push" | "confirm"
  | "transcript" | "validate_intent" | "validate_plan"
  | "scenario_tester" | "scenario_labeler";

export const CANONICAL_MCPS: readonly CanonicalMcp[] = [
  "check", "commit", "push", "confirm", "transcript",
  "validate_intent", "validate_plan", "scenario_tester", "scenario_labeler",
] as const;

export type CanonicalWorkflow =
  | "commit" | "push" | "quickpush" | "confirm"
  | "check"  | "transcript"
  | "plan1"  | "plan3" | "plan5" | "implement";

export const CANONICAL_WORKFLOWS: readonly CanonicalWorkflow[] = [
  "commit", "push", "quickpush", "confirm", "check", "transcript",
  "plan1", "plan3", "plan5", "implement",
] as const;

export interface CanonicalToolCall {
  /** Canonical name: "Edit"/"Bash"/"Write"/"Read"/"mcp-commit"/etc. */
  toolName: string;
  /** Canonical-shape input (adapter wire shape translated to Claude-canonical). */
  toolInput: unknown;
}

export interface ScenarioMaterializeCtx {
  sessionId: string;
  cwd: string;
  permissionMode: string;
  codexCollaborationMode?: "plan" | "default";
  prevUuid: string | null;
  baseTs: number;
}

export interface MaterializedScenarioLine {
  jsonl: string;
  uuid: string;
  toolUseIds: ReadonlyArray<{ refKey: string; resolvedId: string }>;
}

// ── Host context (used by resolveHostContext) ────────────────────────────────

export interface HostContext {
  /** Adapter name string. Typed as string to allow extension. */
  adapter: string;
  projectDir: string;
  configRoot: string;
  plansRoot: string;
  instructionFiles: string[];
  instructionLabel: string;
}

// ── Transcript shape (canonical, used by parseTranscript) ───────────────────

export interface ContentBlock {
  type: string;
  text?: string;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  name?: string;
  id?: string;
  is_error?: boolean;
}

export interface TranscriptEntry {
  isMeta?: boolean;
  message?: {
    id?: string;
    role: string;
    content: string | ContentBlock[];
    stop_reason?: string;
  };
}

/**
 * AdapterSpec — the entire adapter contract. Pure methods.
 * Generic code consumes ONLY these methods. Adapters keep all wire-format
 * knowledge inside method bodies; nothing is exposed as a regex array,
 * a wire-name table, or any other inspectable data structure.
 */
export interface AdapterSpec {
  /** Adapter name. Typed as string so adding adapters needs no shared-code edit. */
  readonly name: string;
  /** Existing AdapterEncoder for stdout shaping. */
  readonly encoder: AdapterEncoder;

  // ── Tool naming ─────────────────────────────────────────────────────────
  /** Recognize an adapter-wire MCP tool name. Returns canonical or null.
   *  Generic code never sees the wire spelling. */
  recognizeMcp(rawToolName: string): CanonicalMcp | null;

  /** Render the wire spelling for a canonical MCP capability. */
  mcpWireName(canonical: CanonicalMcp): string;

  /** Translate a raw wire-shape tool call into canonical form.
   *  Handles MCP recognition, name aliases (apply_patch→Edit, exec_command→Bash),
   *  and input shape translation (parse apply_patch body to {file_path}). */
  canonicalizeToolCall(rawToolName: string, rawToolInput: unknown): CanonicalToolCall;

  // ── Workflow invocation ─────────────────────────────────────────────────
  /** Recognize a workflow invocation in a user message. Generic code
   *  never sees `<command-name>`, `$agent-framework-`, or `/`. */
  recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null;

  /** Render an example invocation for user-facing text.
   *  Claude("commit")→"/commit". Codex("commit")→"$agent-framework-commit". */
  renderWorkflowInvocation(canonical: CanonicalWorkflow): string;

  // ── Transcript parsing (the bug-fix surface) ────────────────────────────
  /** Parse adapter-native JSONL lines into the canonical TranscriptEntry stream.
   *  Codex coalesces multi-line response_items into one entry per logical turn. */
  parseTranscript(rawLines: readonly string[]): readonly (TranscriptEntry | null)[];

  /** True if a content string is an adapter-injected interruption message. */
  isInterruptionMessage(content: string): boolean;

  /** Extract a context-injection message from adapter stdout, or null. */
  extractContextMessage(event: EventName, stdout: string): string | null;

  // ── Path / config conventions ───────────────────────────────────────────
  /** Resolve host context (config root, plans root, instruction files).
   *  Generic code never sees ".claude", ".codex", "CLAUDE.md", "AGENTS.md". */
  resolveHostContext(input: { cwd?: string }): HostContext;

  /** True if a file path is exempt from edit-intent gating
   *  (plan files, memory files, instruction files for this adapter). */
  isEditIntentExemptPath(filePath: string): boolean;

  // ── Plan source / exit conventions ─────────────────────────────────────
  /** Resolve the current plan source using adapter-specific transcript/session conventions. */
  findCurrentPlanSource(input: PlanSourceLookupInput): PlanSourceDescriptor | null | Promise<PlanSourceDescriptor | null>;

  /** True if this adapter-specific event represents a plan-exit/approval boundary. */
  isPlanExit(input: PlanExitDetectionInput): boolean;

  /** Detect native plan mode using adapter-owned host signals. */
  detectPlanMode(input: PlanModeDetectionInput): PlanModeDetection;

  // ── Scenario materialization ────────────────────────────────────────────
  /** Convert one canonical ScenarioEntry into JSONL line(s) on disk
   *  in this adapter's wire format. */
  materializeScenarioEntry(
    entry: unknown,
    ctx: ScenarioMaterializeCtx,
  ): readonly MaterializedScenarioLine[];

  // ── User-facing text helpers ────────────────────────────────────────────
  /** Adapter-active wire spelling rendered for user-facing text. */
  renderCheckMcpHint(): string;
  /** Render an "authorize via workflow" hint listing example invocations. */
  renderWorkflowAuthorizationHint(canonicals: readonly CanonicalWorkflow[]): string;
  /** Instruction-file label for prompts ("CLAUDE.md" / "AGENTS.md/CLAUDE.md"). */
  readonly instructionLabel: string;
}
