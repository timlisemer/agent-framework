import * as path from "path";
import { hostConfigRoot, hostPlansRoot } from "../utils/paths.js";
import { RESTRICTED_MCP_TOOLS } from "../utils/slash-commands.js";

// File tools that go through path-based risk classification (trusted/sensitive)
// and write-specific gates (edit-intent, CLAUDE.md validation, plan-file validation,
// style-drift). Read is NOT here -- it's read-only with no side effects, so it
// belongs in LOW_RISK_TOOLS for immediate auto-approval.
export const FILE_TOOLS = ["Write", "Edit", "NotebookEdit", "apply_patch"];

// Sensitive file patterns - always require LLM approval
export const SENSITIVE_PATTERNS = [
  ".env",
  "credentials",
  ".ssh",
  ".aws",
  "secrets",
  ".key",
  ".pem",
  "password",
];

// Low-risk tools get immediate auto-approval with no further checks.
// These are all read-only or side-effect-free -- they can't modify files,
// execute commands, or affect shared state. Contrast with FILE_TOOLS above,
// which go through write-specific gates (edit-intent, style-drift, etc.).
export const LOW_RISK_TOOLS = [
  // Read-only file/search/navigation
  "Read",
  "LSP",
  "WebSearch",
  "WebFetch",
  "ToolSearch",

  // MCP resource reading (read-only)
  "ListMcpResources",
  "ReadMcpResource",

  // Internal/meta tools (low impact)
  "TodoWrite",
  "TaskOutput",
  "EnterPlanMode",
  "Skill",
];

/**
 * MCP tools that should NEVER auto-approve via low-risk-bypass even when
 * the user is calm. These run heavyweight side effects (multi-minute test
 * suites, label rewrites). Cost-gated, not user-state-gated. Compare with
 * RESTRICTED_MCP_TOOLS, which is auth-gated via slash commands.
 *
 * Distinct concept from cross-turn rejection memory: that lives in mood/
 * trust/frustrationStreak signals consumed by decidePrediction. When the
 * user has asked the assistant to stop, decidePrediction still has a separate
 * sustained-frustration path for tools that do not auto-approve through
 * low-risk-bypass (priority 33), so this constant is purely a cost gate, not
 * a substitute for cross-turn rejection memory.
 */
const HEAVY_MCP_TOOLS: ReadonlySet<string> = new Set([
  "mcp__agent-framework__scenario_tester",
  "mcp__agent-framework__scenario_labeler",
]);

/**
 * True iff a tool is generally safe to allow without further checks.
 * Mirrors the predicate used by `low-risk-bypass` (priority 33) so the
 * sentiment prediction system aligns with the framework-wide allow set.
 *
 * Allows: anything in LOW_RISK_TOOLS, plus any `mcp__*` tool not in
 * `RESTRICTED_MCP_TOOLS` (commit/push/confirm -- slash-command gated)
 * and not in `HEAVY_MCP_TOOLS` (test-harness actions that run suites).
 */
export function isLowRiskTool(toolName: string): boolean {
  return (
    LOW_RISK_TOOLS.includes(toolName) ||
    (toolName.startsWith("mcp__")
      && !RESTRICTED_MCP_TOOLS.has(toolName)
      && !HEAVY_MCP_TOOLS.has(toolName))
  );
}

export const CONFIRMATION_PATTERN = /^\s*(y(es|ep|eah|up)?(\s*please)?|ok(ay)?|sure|go\s*ahead|do\s*it|proceed|confirm(ed)?|approved?|lgtm|sounds?\s*good|that('?s| is)\s*(fine|good|correct|right)|please(\s*do)?|yea|aye|k)\s*[.!]?\s*$/i;

export function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const resolved = path.resolve(filePath);
  const dirResolved = path.resolve(dirPath);
  return (
    resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved
  );
}

export function isTrustedPath(filePath: string, projectDir: string): boolean {
  return (
    isPathInDirectory(filePath, projectDir) ||
    isPathInDirectory(filePath, hostConfigRoot())
  );
}

export function isSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return SENSITIVE_PATTERNS.some((p) => lower.includes(p));
}

/**
 * Extract path or command from tool input for logging.
 */
export function extractPathOrCmd(toolInput: unknown): { path?: string; cmd?: string } {
  const input = toolInput as Record<string, unknown>;
  return {
    path: (input?.file_path as string) ?? (input?.notebook_path as string) ?? (input?.path as string) ?? undefined,
    cmd: (input?.command as string) ?? undefined,
  };
}

/**
 * True iff filePath (resolved absolute) is inside ~/.claude/plans.
 */
export function isPlanFile(filePath: string): boolean {
  return isPathInDirectory(filePath, hostPlansRoot());
}

/**
 * Extract the file path arg from a file-tool input (Write/Edit/NotebookEdit).
 * NotebookEdit uses `notebook_path`; others use `file_path`. Read uses `path`
 * but is not a file-mutating tool so callers generally skip it.
 */
export function extractFilePath(
  toolName: string,
  toolInput: unknown,
): string | undefined {
  const input = toolInput as {
    file_path?: unknown;
    notebook_path?: unknown;
    path?: unknown;
  } | undefined;
  if (toolName === "apply_patch") {
    return extractApplyPatchPaths(toolInput)[0];
  }

  const raw =
    (toolName === "NotebookEdit" ? input?.notebook_path : input?.file_path) ??
    input?.path;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function extractFilePaths(
  toolName: string,
  toolInput: unknown,
): string[] {
  if (toolName === "apply_patch") return extractApplyPatchPaths(toolInput);
  const single = extractFilePath(toolName, toolInput);
  return single ? [single] : [];
}

function extractApplyPatchPaths(toolInput: unknown): string[] {
  const command = typeof toolInput === "string"
    ? toolInput
    : (toolInput as { command?: unknown; patch?: unknown } | undefined)?.command ??
      (toolInput as { patch?: unknown } | undefined)?.patch;
  if (typeof command !== "string") return [];
  const paths: string[] = [];
  for (const line of command.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return [...new Set(paths)];
}
