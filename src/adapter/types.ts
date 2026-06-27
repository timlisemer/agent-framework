/**
 * Adapter contract — canonical types and the AdapterSpec method interface.
 *
 * Generic code depends ONLY on the types and methods defined here. All
 * adapter-specific wire spellings, path literals, and regexes live inside
 * the adapter implementations under adapters/<name>/.
 *
 * @module adapter/types
 */

import type { AiMetadata, AiProviderMetadataState, TokenUsage } from "../ai-protocol/index.js";
import type { RuntimeHomeProfile, RuntimeToolPolicy } from "../runtime-home/profiles.js";
import type { ToolLogEntry } from "../utils/session-store.js";

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

export interface NativePlanFileLookupInput {
  transcriptPath: string;
  sessionDir?: string;
  planName?: string;
}

export type NativePlanFileLookup =
  (input: NativePlanFileLookupInput) => Promise<string | null> | string | null;

export type PlanSourceDescriptor =
  { kind: "file"; path: string; planName?: string };

export type PlanExitDetectionInput =
  | { event: "PreToolUse"; canonicalToolName?: string; rawToolName?: string; toolInput?: unknown }
  | { event: "Stop"; assistantText?: string | null }
  | { event: "UserPromptSubmit"; prompt: string };

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
  | "check" | "commit" | "push" | "confirm" | "fullconfirm"
  | "implement" | "validate_implementation"
  | "transcript" | "validate_intent" | "validate_plan" | "create_planfile"
  | "scenario_tester" | "scenario_labeler" | "locate_scenario";

export const CANONICAL_MCPS: readonly CanonicalMcp[] = [
  "check", "commit", "push", "confirm", "fullconfirm", "transcript",
  "implement", "validate_implementation", "validate_intent", "validate_plan", "create_planfile", "scenario_tester", "scenario_labeler",
  "locate_scenario",
] as const;

export type CanonicalWorkflow =
  | "commit" | "push" | "quickpush" | "confirm" | "quickconfirm" | "fullconfirm" | "fullquickconfirm"
  | "check"  | "transcript" | "locate-scenario"
  | "plan1"  | "plan3" | "plan5" | "implement" | "validate";

export const CANONICAL_WORKFLOWS: readonly CanonicalWorkflow[] = [
  "commit", "push", "quickpush", "confirm", "quickconfirm", "fullconfirm", "fullquickconfirm", "check", "transcript", "locate-scenario",
  "plan1", "plan3", "plan5", "implement", "validate",
] as const;

export interface CanonicalToolCall {
  /** Canonical name: "Edit"/"Bash"/"Write"/"Read"/"mcp-commit"/etc. */
  toolName: string;
  /** Canonical-shape input (adapter wire shape translated to Claude-canonical). */
  toolInput: unknown;
}

export interface AdapterToolCallContext {
  rawToolName: string;
  rawToolInput: unknown;
  canonicalToolName: string;
  canonicalToolInput: unknown;
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

export interface AdapterRuntimeHomeSpec {
  dotRoot(adapterRoot: string): string;
  authFiles: readonly string[];
  durableManagedEntries: readonly string[];
  applyRuntimeEnv(env: NodeJS.ProcessEnv, root: string | null): NodeJS.ProcessEnv;
  resolveNativeRoot(input: {
    env: NodeJS.ProcessEnv;
    homeDir: string;
    managedRoot: string;
  }): string;
  writeMinimalConfig?(root: string): void;
  rewriteConfig?(root: string, profile: RuntimeHomeProfile): void;
  sandboxModeForToolPolicy?(policy: RuntimeToolPolicy): string | null;
  removeMcpServerConfig(root: string): void;
  sanitizeLocalSettings?(root: string): void;
  removeHooksConfig(root: string): void;
  removeStopHookFromSettings?(root: string): void;
  buildHookTrustBlock?(hooksConfigPath: string, hooksSourcePath: string): string;
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

export interface AdapterTranscriptFile {
  name: string;
  path: string;
}

export type AdapterResumeTarget = {
  provider: string;
  target: Record<string, string>;
};

export type AdapterSessionHistoryRecord = {
  adapterName: string;
  targetKey: string;
  summary: string;
  workingDir: string;
  createdAt?: string;
  updatedAt?: string;
  resumeTarget: AdapterResumeTarget;
  transcriptPath?: string;
  nativeSessionId?: string;
};

export interface AdapterSessionHistoryProvider {
  listManagedSessions(input: {
    maxResults: number;
  }): Promise<readonly AdapterSessionHistoryRecord[]> | readonly AdapterSessionHistoryRecord[];
}

// ── Transcript shape (canonical, used by parseTranscript) ───────────────────

export type TranscriptSource = {
  adapter: string;
  sourceKey: string;
  transcriptPath?: string;
  startLine: number;
  endLine: number;
  nativeId?: string;
  createdAt?: string;
};

export type TranscriptParseOptions = {
  startLine?: number;
  transcriptPath?: string;
};

export interface ProviderMetadataExtractionInput {
  rawLines: readonly string[];
  transcriptPath?: string;
}

export interface ContentBlock {
  type: string;
  text?: string;
  content?: unknown;
  tool_use_id?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  is_error?: boolean;
  source?: TranscriptSource;
  metadata?: AiMetadata;
}

export interface TranscriptEntry {
  isMeta?: boolean;
  source?: TranscriptSource;
  createdAt?: string;
  usage?: TokenUsage | null;
  metadata?: AiMetadata;
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
  /** Adapter-owned runtime-home filesystem and config behavior. */
  readonly runtimeHome: AdapterRuntimeHomeSpec;

  // ── Tool naming ─────────────────────────────────────────────────────────
  /** Recognize an adapter-wire MCP tool name. Returns canonical or null.
   *  Generic code never sees the wire spelling. */
  recognizeMcp(rawToolName: string): CanonicalMcp | null;

  /** Render the wire spelling for a canonical MCP capability. */
  mcpWireName(canonical: CanonicalMcp): string;

  /** Recognize split SDK MCP identity fields such as server/tool. */
  recognizeMcpServerTool(server: string, tool: string): CanonicalMcp | null;

  /** Translate a raw wire-shape tool call into canonical form.
   *  Handles MCP recognition, adapter-specific name aliases, and input
   *  shape translation. */
  canonicalizeToolCall(rawToolName: string, rawToolInput: unknown): CanonicalToolCall;

  /** Summarize a tool call for LLM-facing gate/appeal prompts. Receives both
   *  raw adapter-wire identity and canonical identity so adapters can explain
   *  host-specific aliases without fabricating fields. */
  summarizeToolCallForLlm(input: AdapterToolCallContext): string;

  /** Adapter-specific fallback matching for transcript tool calls and
   *  agent-framework tool-log entries when native runtime IDs differ. */
  toolLogEntryMatchesTranscriptTool?(entry: ToolLogEntry, toolName: string, input: unknown): boolean;
  transcriptToolLogIdentityKey?(toolName: string, input: unknown): string | null;
  transcriptToolLogMatchIsStable?(toolName: string, input: unknown): boolean;
  transcriptMessageGroupKey?(entry: TranscriptEntry): string | null;

  /** True when a deny reason is impossible for this adapter-specific call
   *  shape and should be treated as hallucinated rule-gate output. */
  isFabricatedDenyReason?(reason: string, input: AdapterToolCallContext): boolean;

  /** True when a raw adapter tool name is a user-visible alias for the
   *  matching canonical tool in appeal prompts. */
  rawToolNameIsAppealAlias?(input: AdapterToolCallContext): boolean;

  // ── Workflow invocation ─────────────────────────────────────────────────
  /** Recognize a workflow invocation in a user message. Generic code
   *  never sees `<command-name>`, `$agent-framework-`, or `/`. */
  recognizeWorkflowInvocation(content: string): CanonicalWorkflow | null;

  /** True only when the entire user entry is an adapter workflow/skill
   *  wrapper, not when human prose merely mentions a workflow invocation. */
  isWorkflowInvocationOnly(content: string): boolean;

  /** Render an example invocation for user-facing text.
   *  Claude("commit")→"/commit". Codex("commit")→"$agent-framework-commit". */
  renderWorkflowInvocation(canonical: CanonicalWorkflow): string;

  /** Read canonicalized instruction text for a workflow/skill. Adapters own
   *  parsing/normalizing host wire spellings before generic prediction code
   *  derives canonical workflow requirements from the returned text. */
  workflowInstructionText(canonical: CanonicalWorkflow, host: HostContext): string | null;

  // ── Transcript parsing (the bug-fix surface) ────────────────────────────
  /** Parse adapter-native JSONL lines into the canonical TranscriptEntry stream.
   *  Codex coalesces multi-line response_items into one entry per logical turn. */
  parseTranscript(rawLines: readonly string[], options?: TranscriptParseOptions): readonly (TranscriptEntry | null)[];

  /** Extract provider-owned metadata from adapter-native transcript rows. */
  extractProviderMetadata?(
    input: ProviderMetadataExtractionInput,
  ): Partial<AiProviderMetadataState>;

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

  /** Default raw transcript directory for a project under this adapter. */
  projectTranscriptsDir(projectDir?: string): string;

  /** Default raw transcript file for a session name under this adapter. */
  projectTranscriptFile(name: string, projectDir?: string): string;

  /** Raw transcript candidates for a project under this adapter. */
  listProjectTranscripts(projectDir?: string): readonly AdapterTranscriptFile[];

  /** Adapter-owned managed session history discovery for AI panel resume. */
  sessionHistory?: AdapterSessionHistoryProvider;

  // ── Plan source / exit conventions ─────────────────────────────────────
  /** Resolve an adapter-native plan file for a named/current plan, if one exists. */
  findNativePlanFile(input: NativePlanFileLookupInput): string | null | Promise<string | null>;

  /** True if this adapter-specific event represents a plan-exit/approval boundary. */
  isPlanExit(input: PlanExitDetectionInput): boolean;

  /** Extract adapter-specific proposed plan content from a Stop response, if any. */
  extractStopProposedPlan(assistantText: string | null | undefined): string | null;

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
