/**
 * Edit Intent Detection - Deterministic + LLM fallback classification
 *
 * Pure TypeScript utilities for detecting whether a user message indicates
 * intent to edit files. Used by user-prompt-submit.ts (sync fast path)
 * and summary-updater.ts (LLM fallback for ambiguous cases).
 *
 * @module edit-intent
 */

// Tools that modify files
const EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Check if a tool name is a file-editing tool.
 */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.includes(toolName);
}

/**
 * Check if a file path is exempt from edit intent blocking.
 * Plan files, memory files, and CLAUDE.md are handled by their own validators.
 */
export function isEditIntentExemptPath(filePath: string): boolean {
  // Plan files
  if (filePath.includes("/.claude/plans/")) return true;
  // Memory files
  if (filePath.includes("/.claude/projects/") && (filePath.includes("/memory/") || filePath.endsWith("MEMORY.md"))) return true;
  // CLAUDE.md
  if (filePath.endsWith("CLAUDE.md")) return true;
  return false;
}

export type EditSignalResult = "edit" | "non-edit" | "ambiguous";

// --- EDIT SIGNAL PATTERNS (positive -- user wants edits) ---
const EDIT_SIGNAL_PATTERNS: RegExp[] = [
  // Direct imperative verbs
  /^(please\s+)?(fix|update|change|modify|edit|refactor|rename|replace|rewrite|restructure|delete|remove|add|create|implement|write|build|set up|setup|configure|integrate|convert|migrate|extract|split|merge|introduce|insert)\b/i,

  // Polite imperatives: "can you fix", "could you update"
  /\b(can you|could you|would you|please)\s+(fix|update|change|modify|edit|refactor|rename|replace|rewrite|add|create|implement|write|remove|delete)\b/i,

  // Informal: "let's refactor", "gonna need you to fix"
  /\b(gonna need you to|let'?s|lets|go ahead and|need you to|want you to)\s+(fix|update|change|modify|edit|add|create|implement|write|remove|delete|refactor)\b/i,

  // "Make it work/better/correct"
  /\bmake\s+(it|this|that|the)\b.*\b(work|better|faster|correct|proper|right)\b/i,

  // Error-driven edits: "fix the bug", "it doesn't work"
  /\b(fix|resolve|handle|address|patch)\s+(the\s+)?(bug|error|issue|problem|crash)\b/i,
  /\b(it'?s broken|doesn'?t work|not working|fails|failing|crashed)\b/i,

  // File-targeted: "in src/auth.ts"
  /\b(in|to)\s+\S+\.(ts|js|py|rs|go|java|tsx|jsx|svelte|css|html|json|yaml|toml|nix)\b/i,

  // Plan-to-implementation transitions
  /\b(exit plan|start implementing|begin implementation|implement the plan|execute)\b/i,
];

// Short affirmative patterns (only edit when previousEditIntent=true)
const SHORT_AFFIRMATIVE_PATTERN = /^(yes|yeah|yep|sure|ok|okay|go ahead|proceed|continue|do it|go for it|sounds good|looks good|lgtm|ship it|approved)\s*[.!]?\s*$/i;

// --- NON-EDIT SIGNAL PATTERNS (negative -- user does NOT want edits) ---
const NON_EDIT_SIGNAL_PATTERNS: RegExp[] = [
  // Pure reading/investigation
  /^(please\s+)?(explain|describe|show|read|look at|check|review|examine|find|search|list|summarize|compare|analyze|understand|trace|investigate|explore)\b/i,

  // Explicit negation of edits
  /\b(don'?t|do not|never|stop)\s+(edit|change|modify|update|write|create|delete|remove|touch|alter)\b/i,

  // Questions (excluding "can you fix" style)
  /^(what|where|when|why|how|which|who|is|are|does|do|did|has|have)\s+(?!you\s+(fix|update|change|modify|edit|add|create|implement|write|remove|delete))/i,

  // "Explain how to" (explain, not do)
  /\b(explain|describe|tell me)\s+(how to|what|why|when|where)\b/i,

  // Pure conversation enders
  /^(thanks|thank you|thx|ty|cool|nice|great|got it|understood|i see|makes sense|never mind|nvm)\s*[.!?]?\s*$/i,

  // "What about X?" (inquiry, not instruction)
  /^what about\b/i,

  // Plan/design requests (not implementation)
  /\b(plan|design|architect|outline|propose|brainstorm|think about|consider)\s+(for|how|a|the|this|an)\b/i,

  // "Don't write plan yet" detection
  /\b(don'?t|do not)\s+(write|create|start)\s+(a\s+|the\s+)?plan\b/i,
  /\b(not ready|hold off|wait|don'?t start)\b.*\b(yet|first|now)\b/i,
];

// Compound override: non-edit matched BUT message also contains "and/then + edit_verb"
const COMPOUND_OVERRIDE_PATTERN = /\b(and|then)\s+(fix|update|change|modify|edit|refactor|rename|replace|rewrite|add|create|implement|write|remove|delete)\b/i;

/**
 * Deterministic edit signal detection.
 * Returns tristate: "edit", "non-edit", or "ambiguous".
 *
 * Evaluation order:
 * 1. Non-edit patterns checked FIRST so "explain how to fix" resolves to non-edit
 * 2. Compound override: "review and fix" flips back to edit
 * 3. Edit patterns checked
 * 4. Short affirmatives depend on previousEditIntent
 * 5. Fallback: ambiguous
 */
export function detectEditSignal(userMessage: string, previousEditIntent: boolean): EditSignalResult {
  const trimmed = userMessage.trim();
  if (!trimmed) return "ambiguous";

  // Check non-edit patterns first
  const isNonEdit = NON_EDIT_SIGNAL_PATTERNS.some((p) => p.test(trimmed));

  if (isNonEdit) {
    // Compound override: "review and fix" -> edit
    if (COMPOUND_OVERRIDE_PATTERN.test(trimmed)) {
      return "edit";
    }
    return "non-edit";
  }

  // Check edit patterns
  const isEdit = EDIT_SIGNAL_PATTERNS.some((p) => p.test(trimmed));
  if (isEdit) return "edit";

  // Short affirmatives: edit ONLY when previousEditIntent=true
  if (SHORT_AFFIRMATIVE_PATTERN.test(trimmed)) {
    if (previousEditIntent) return "edit";
    return "ambiguous";
  }

  return "ambiguous";
}

/**
 * Parse the output of the EDIT_INTENT_AGENT LLM.
 * Returns true for EDIT, false for NON-EDIT, null for garbage.
 */
export function parseEditIntentOutput(output: string): boolean | null {
  const trimmed = output.trim().toUpperCase();
  if (trimmed === "EDIT" || trimmed.startsWith("EDIT")) {
    // Make sure it's not "EDIT" as part of "NON-EDIT"
    if (trimmed.startsWith("NON-EDIT") || trimmed.startsWith("NON EDIT")) return false;
    return true;
  }
  if (trimmed === "NON-EDIT" || trimmed.startsWith("NON-EDIT") || trimmed.startsWith("NON EDIT")) {
    return false;
  }
  return null;
}

/**
 * Determine if an edit tool call should be blocked based on edit intent and path.
 * Returns true if the tool should be blocked (denied).
 *
 * - editIntent=false + edit tool + non-exempt path -> blocked
 * - editIntent=true or null -> not blocked (fail-open for null)
 * - Read tool -> never blocked
 * - Exempt paths (plan files, memory files, CLAUDE.md) -> never blocked
 */
export function shouldBlockEdit(
  editIntent: boolean | null,
  toolName: string,
  filePath: string
): boolean {
  if (editIntent !== false) return false;
  if (!isEditTool(toolName)) return false;
  if (isEditIntentExemptPath(filePath)) return false;
  return true;
}

/**
 * Classify edit intent from a user message synchronously.
 * Encapsulates the plan-mode check, stickiness check, and regex detection.
 *
 * @param userMessage - The user's message text
 * @param previousEditIntent - The previous edit intent value (from SessionState)
 * @param editIntentTimestamp - When the previous edit intent was set
 * @param planMode - Whether plan mode is currently active
 * @returns true (edit), false (non-edit), or null (ambiguous, needs LLM)
 */
export function classifyEditIntent(
  userMessage: string,
  previousEditIntent: boolean | null,
  editIntentTimestamp: number,
  planMode: boolean
): boolean | null {
  const now = Date.now();

  // Plan mode -> non-edit
  if (planMode) return false;

  // Stickiness: if previous was edit and not timed out
  if (
    previousEditIntent === true &&
    (now - editIntentTimestamp) < STICKINESS_TIMEOUT_MS
  ) {
    const signal = detectEditSignal(userMessage, true);
    if (signal === "non-edit") return false;
    // Sticky: keep edit intent (both "edit" and "ambiguous" maintain stickiness)
    return true;
  }

  // TypeScript detection
  const signal = detectEditSignal(userMessage, previousEditIntent === true);
  if (signal === "edit") return true;
  if (signal === "non-edit") return false;
  return null; // ambiguous -> LLM fallback
}

/** Stickiness timeout: 10 minutes */
export const STICKINESS_TIMEOUT_MS = 10 * 60 * 1000;

// --- Bash commands that perform writes/mutations ---
const BASH_WRITE_PATTERNS: RegExp[] = [
  /\b(echo|printf)\s+.*>/,
  /\btee\s+/,
  /\bsed\s+-i/,
  /\b(mkdir|touch|rm|mv|cp)\s+/,
  /\bgit\s+(commit|push|add|merge|rebase|reset)\b/,
  /\bnpm\s+(install|run\s+build)\b/,
];

/**
 * Hard block for edit tools during plan mode.
 * Returns a denial reason if the tool should be blocked, or null if allowed.
 *
 * During plan mode, ONLY plan files and exempt paths may be edited.
 * This is a hard block — no LLM appeal can overturn it.
 */
export function planModeEditBlock(
  planMode: boolean,
  toolName: string,
  filePath: string
): string | null {
  if (!planMode) return null;
  if (!isEditTool(toolName)) return null;
  if (isEditIntentExemptPath(filePath)) return null;
  return `Plan mode is active - file edits are blocked. Only plan files may be modified. Target: ${filePath}`;
}

/**
 * Hard block for write-like Bash commands during plan mode.
 * Returns a denial reason if the command should be blocked, or null if allowed.
 */
export function planModeBashBlock(
  planMode: boolean,
  toolName: string,
  command: string
): string | null {
  if (!planMode) return null;
  if (toolName !== "Bash") return null;
  for (const pattern of BASH_WRITE_PATTERNS) {
    if (pattern.test(command)) {
      return `Plan mode is active - write commands are blocked. Command: ${command.slice(0, 100)}`;
    }
  }
  return null;
}
