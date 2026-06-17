import * as path from "path";
import { hostConfigRoot, hostPlansRoot, sessionPlansDir } from "../utils/paths.js";
import { isSessionPlanfilePath } from "../utils/planfile.js";
import { RESTRICTED_MCPS } from "../utils/slash-commands.js";
import { activeSpec } from "../adapter/spec.js";
import type { CanonicalMcp } from "../adapter/types.js";
export { isSensitivePath } from "../utils/sensitive-paths.js";

// File tools that go through path-based risk classification (trusted/sensitive)
// and write-specific gates (edit-intent, CLAUDE.md validation, plan-file validation,
// style-drift). Read is NOT here -- it's read-only with no side effects, so it
// belongs in LOW_RISK_TOOLS for prediction/default non-blocking classification.
// apply_patch is excluded: Codex canonicalizes it to Edit before rules run.
export const FILE_TOOLS = ["Write", "Edit", "NotebookEdit"];

// Low-risk tools are read-only or side-effect-free for prediction policy and
// default workflow non-blocking support. Contrast with FILE_TOOLS above, which
// go through write-specific gates (edit-intent, style-drift, etc.).
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
 * MCP canonical names that should NEVER be classified as low-risk even when
 * the user is calm. These run heavyweight side effects (multi-minute test
 * suites, label rewrites). Cost-gated, not user-state-gated.
 */
const HEAVY_MCPS: ReadonlySet<CanonicalMcp> = new Set(["scenario_tester", "scenario_labeler"]);

/**
 * True iff a tool is generally safe for low-risk prediction treatment.
 *
 * Allows: anything in LOW_RISK_TOOLS, plus any canonical MCP tool not in
 * `RESTRICTED_MCPS` (commit/push/confirm -- slash-command gated) and not
 * in `HEAVY_MCPS` (test-harness actions that run suites).
 *
 * For raw (pre-canonicalization) MCP names, use recognizeMcp first.
 */
export function isLowRiskTool(toolName: string): boolean {
  if (LOW_RISK_TOOLS.includes(toolName)) return true;
  // Check if it's a canonical mcp- prefixed tool
  if (toolName.startsWith("mcp-")) {
    const canonical = toolName.slice(4) as CanonicalMcp;
    return !RESTRICTED_MCPS.has(canonical) && !HEAVY_MCPS.has(canonical);
  }
  // Legacy: recognize via active spec (wire names that weren't yet canonicalized)
  const mcp = activeSpec().recognizeMcp(toolName);
  if (mcp) {
    return !RESTRICTED_MCPS.has(mcp) && !HEAVY_MCPS.has(mcp);
  }
  return false;
}

/**
 * Low-risk tools that inspect external state/content. Excludes low-risk
 * workflow/meta tools such as Skill, TodoWrite, TaskOutput, and EnterPlanMode.
 */
export function isLowRiskInspectionTool(toolName: string): boolean {
  if (["Read", "LSP", "WebSearch", "WebFetch", "ToolSearch", "ListMcpResources", "ReadMcpResource"].includes(toolName)) {
    return true;
  }
  if (toolName.startsWith("mcp-")) {
    const canonical = toolName.slice(4) as CanonicalMcp;
    return !RESTRICTED_MCPS.has(canonical) && !HEAVY_MCPS.has(canonical);
  }
  const mcp = activeSpec().recognizeMcp(toolName);
  if (mcp) {
    return !RESTRICTED_MCPS.has(mcp) && !HEAVY_MCPS.has(mcp);
  }
  return false;
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
 * True iff filePath (resolved absolute) is inside the host plans root.
 */
export function isPlanFile(filePath: string, sessionDir?: string): boolean {
  return isPathInDirectory(filePath, hostPlansRoot()) ||
    (sessionDir ? isSessionPlanfilePath(filePath, sessionDir) : false);
}

export function isPlanFileForSession(filePath: string, sessionDir: string): boolean {
  return isPathInDirectory(filePath, hostPlansRoot()) ||
    isPathInDirectory(filePath, sessionPlansDir(sessionDir));
}

/**
 * Extract the file path arg from a file-tool input (Write/Edit/NotebookEdit).
 * NotebookEdit uses `notebook_path`; others use `file_path`. Read uses `path`
 * but is not a file-mutating tool so callers generally skip it.
 *
 * Note: apply_patch is handled by the Codex adapter (canonicalized to Edit)
 * before rules run, so it never appears here.
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

  const raw =
    (toolName === "NotebookEdit" ? input?.notebook_path : input?.file_path) ??
    input?.path;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function extractFilePaths(
  toolName: string,
  toolInput: unknown,
): string[] {
  const input = toolInput as { file_paths?: unknown } | undefined;
  if (Array.isArray(input?.file_paths)) {
    return input.file_paths.filter((p): p is string => typeof p === "string" && p.length > 0);
  }
  const single = extractFilePath(toolName, toolInput);
  return single ? [single] : [];
}
