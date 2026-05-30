/**
 * Edit Intent Detection - prediction-derived classification.
 *
 * Edit-intent derivation utilities. `deriveEditIntentFromPrediction` computes
 * intent from a ToolPrediction post-SENTIMENT_AGENT. `shouldBlockEdit`,
 * `planModeEditBlock`, `planModeBashBlock` enforce downstream policy.
 *
 * @module edit-intent
 */

import type { ToolPrediction } from "./prediction-types.js";
import { getBlacklistHighlights, PLAN_MODE_BASH_WRITE_PATTERNS } from "./bash-command-policy.js";
import { activeSpec } from "../adapter/spec.js";
import { isSessionPlanfilePath } from "./planfile.js";

// Tools that modify files (apply_patch is handled by Codex adapter → Edit before rules run)
const EDIT_TOOLS = ["Write", "Edit", "NotebookEdit"];

/**
 * Check if a tool name is a file-editing tool.
 */
export function isEditTool(toolName: string): boolean {
  return EDIT_TOOLS.includes(toolName);
}

/**
 * Check if a file path is exempt from edit intent blocking.
 * Delegates to the active adapter spec which knows its own exempt paths.
 */
export function isEditIntentExemptPath(filePath: string, sessionDir?: string): boolean {
  return activeSpec().isEditIntentExemptPath(filePath) ||
    (sessionDir ? isSessionPlanfilePath(filePath, sessionDir) : false);
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
  filePath: string,
  sessionDir?: string,
): boolean {
  if (editIntent !== false) return false;
  if (!isEditTool(toolName)) return false;
  if (isEditIntentExemptPath(filePath, sessionDir)) return false;
  return true;
}

/**
 * Derive edit-intent from a completed ToolPrediction. Returns true/false/null.
 *
 * Signal priority (first hit wins):
 *   1. blockAllTools → false
 *   2. any explicitlyAllowedTools entry is an edit tool → true
 *   3. any explicitlyBlockedSubstrings entry targets an edit tool → false
 *   4. blockedIntent contains a read-only or don't-edit verb → false
 *   5. full user message contains a don't-edit verb → false
 *   6. full user message contains an implementation verb → true
 *   7. intent contains an implementation verb → true
 *   8. intent contains a read-only verb → false
 *   9. otherwise → null (genuinely ambiguous)
 */
export function deriveEditIntentFromPrediction(
  p: ToolPrediction,
): boolean | null {
  if (p.blockAllTools) return false;
  if (p.explicitlyAllowedTools.some(isEditTool)) return true;
  if (p.explicitlyBlockedSubstrings.some((b) => isEditTool(b.tool))) return false;

  const blocked = p.blockedIntent.toLowerCase();
  if (/\b(read[-\s]?only|just\s+(explor\w*|read\w*|look\w*|investigat\w*|analy[sz]\w*|review\w*|check\w*|examin\w*))\b/.test(blocked)) return false;
  if (/\b(don'?t|do\s+not|no|never|stop|avoid)\s+(edit\w*|chang\w*|modif\w*|writ\w*|creat\w*|updat\w*|delet\w*|touch\w*|refactor\w*|add\w*|remov\w*|replac\w*)\b/.test(blocked)) return false;

  const userMessage = (p.userMessageFull ?? p.userMessageSnippet).toLowerCase();
  if (/\b(don'?t|do\s+not|no|never|stop|avoid)\s+(edit\w*|chang\w*|modif\w*|writ\w*|creat\w*|updat\w*|delet\w*|touch\w*|refactor\w*|add\w*|remov\w*|replac\w*)\b/.test(userMessage)) return false;
  if (/\b(fix\w*|implement\w*|refactor\w*|add\w*|edit\w*|writ\w*|creat\w*|modif\w*|delet\w*|remov\w*|updat\w*|chang\w*|build\w*|set\s+up|setup|configur\w*|renam\w*|replac\w*|rewrit\w*|integrat\w*|migrat\w*|extract\w*|split\w*|merg\w*|introduc\w*|insert\w*|adjust\w*|tweak\w*|correct\w*|improv\w*|enhanc\w*|optimi[sz]\w*|appl\w*|patch\w*|restructur\w*|clean\s*up|hook\s*up|wire\s*up|tidy\w*|format\w*|simplif\w*|polish\w*|port\w*|rollback\w*|upgrad\w*|bump\w*|hotfix\w*|extend\w*|revert\w*|commit\w*|ship\w*|swap\w*)\b/.test(userMessage)) return true;

  const intent = p.intent.toLowerCase();
  // Stem-match implementation verbs to catch morphological variants
  // (fixes/fixing/fixed, refactoring/refactored, changes/changing/changed, etc.)
  if (/\b(fix\w*|implement\w*|refactor\w*|add\w*|edit\w*|writ\w*|creat\w*|modif\w*|delet\w*|remov\w*|updat\w*|chang\w*|build\w*|set\s+up|setup|configur\w*|renam\w*|replac\w*|rewrit\w*|integrat\w*|migrat\w*|extract\w*|split\w*|merg\w*|introduc\w*|insert\w*|adjust\w*|tweak\w*|correct\w*|improv\w*|enhanc\w*|optimi[sz]\w*|appl\w*|patch\w*|restructur\w*|clean\s*up|hook\s*up|wire\s*up|tidy\w*|format\w*|simplif\w*|polish\w*|port\w*|rollback\w*|upgrad\w*|bump\w*|hotfix\w*|extend\w*|revert\w*|commit\w*|ship\w*|swap\w*)\b/.test(intent)) return true;
  if (/\b(explain\w*|read\w*|plan\w*|investigat\w*|explor\w*|review\w*|describ\w*|analy[sz]\w*|understand\w*|trac\w*|show\w*|examin\w*|check\w*|find\w*|look\w*|search\w*|list\w*|summari[sz]\w*|compar\w*|inspect\w*|walk\w*|document\w*)\b/.test(intent)) return false;

  return null;
}

const PLAN_MODE_SCRATCH_GUIDANCE =
  "If you need a scratch/test script, do NOT write to /tmp directly. Instead write it under " +
  "/tmp/claude-test-scripts/<repo-path>/<YYYY-MM-DD-HHMM>/ (repo-path = absolute path of the current " +
  "working directory, date/time to the minute) AND first ask the user for explicit permission via the " +
  "AskUserQuestion tool before creating the file.";

/**
 * Appealable block for edit tools during plan mode.
 * Returns a denial reason if the tool should be blocked, or null if allowed.
 * Only plan files and exempt paths may be edited; everything else is routed
 * through the tool-appeal agent.
 */
export function planModeEditBlock(
  planMode: boolean,
  toolName: string,
  filePath: string,
  sessionDir?: string,
): string | null {
  if (!planMode) return null;
  if (!isEditTool(toolName)) return null;
  if (isEditIntentExemptPath(filePath, sessionDir)) return null;
  return `Plan mode is active - file edits are blocked. Only plan files may be modified. Target: ${filePath}. ${PLAN_MODE_SCRATCH_GUIDANCE}`;
}

/**
 * Appealable block for write-like Bash commands during plan mode.
 * Returns a denial reason if the command should be blocked, or null if allowed.
 */
export function planModeBashBlock(
  planMode: boolean,
  toolName: string,
  command: string,
  workingDir?: string,
): string | null {
  if (!planMode) return null;
  if (toolName !== "Bash") return null;
  if (getBlacklistHighlights(toolName, { command }, workingDir).length > 0) return null;
  for (const pattern of PLAN_MODE_BASH_WRITE_PATTERNS) {
    if (pattern.test(command)) {
      return `Plan mode is active - write commands are blocked. Command: ${command.slice(0, 100)}. ${PLAN_MODE_SCRATCH_GUIDANCE}`;
    }
  }
  return null;
}

// --- Verb → tool morphology used by SENTIMENT_AGENT-side enrichment ---
// Mirrors the SENTIMENT_AGENT prompt's verb-mapping bullets. Kept narrow on
// purpose: regex catches unambiguous cases, the LLM still adds tools the
// regex misses (union semantics in user-prompt-submit.ts).

export const READ_VERB_RE = /\b(read|show|look\s+at|open|view|inspect|examin\w*)\b/i;
export const EDIT_VERB_RE =
  /\b(edit|chang\w*|fix\w*|implement(?:s|ing|ed)?|modif(?:y|ies|ying|ied)|refactor(?:s|ing|ed)?|patch(?:es|ing|ed)?|writ\w*|creat\w*|sav\w*|add\s+to\s+(?:file|the\s+file)|rewrit\w*|redo|undo|undone|revert\w*|restor\w*|rollback|roll\s+back|put\s+back|delet\w*|remov\w*)\b/i;
// Bounded distance so unrelated mentions of "file" don't pull in Bash.
export const RENAME_MOVE_VERB_RE = /\b(renam\w*|mov\w*)\b[^.!?]{0,50}\b(file|files)\b/i;
export const TEST_RUN_VERB_RE = /\b(test|tests|run\s+\w+)\b/i;
export const BASH_INSPECTION_VERB_RE =
  /\b(investigat\w*|explor\w*|search\w*|grep|rg|find|list|check|look\s+into|trace|inspect)\b/i;
export const COMMIT_VERB_RE = /\bcommit\b/i;
export const PUSH_VERB_RE = /\bpush\b/i;
export const CHECK_VERB_RE = /\b(typecheck|build|check|lint)\b/i;

/**
 * Derive the set of tool names whose use the user's imperative verb morphology
 * unambiguously requires. Returned set is unioned (not overridden) with the
 * SENTIMENT_AGENT's own `explicitlyAllowedTools` output by user-prompt-submit.
 */
export function deriveAllowedToolsFromIntent(message: string): string[] {
  const tools = new Set<string>();
  if (READ_VERB_RE.test(message)) tools.add("Read");
  if (EDIT_VERB_RE.test(message)) {
    tools.add("Edit");
    tools.add("Write");
  }
  if (RENAME_MOVE_VERB_RE.test(message)) tools.add("Bash");
  if (TEST_RUN_VERB_RE.test(message)) tools.add("Bash");
  if (BASH_INSPECTION_VERB_RE.test(message)) tools.add("Bash");
  if (COMMIT_VERB_RE.test(message)) {
    tools.add("mcp-commit");
  }
  if (PUSH_VERB_RE.test(message)) {
    tools.add("mcp-push");
  }
  if (CHECK_VERB_RE.test(message)) {
    tools.add("mcp-check");
  }
  return [...tools];
}
