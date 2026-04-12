import * as path from "path";
import * as os from "os";

// File tools that go through path-based risk classification (trusted/sensitive)
// and write-specific gates (edit-intent, CLAUDE.md validation, plan-file validation,
// style-drift). Read is NOT here -- it's read-only with no side effects, so it
// belongs in LOW_RISK_TOOLS alongside Grep/Glob for immediate auto-approval.
export const FILE_TOOLS = ["Write", "Edit", "NotebookEdit"];

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
  "Grep",
  "Glob",
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

export const CONFIRMATION_PATTERN = /^\s*(y(es|ep|eah|up)?(\s*please)?|ok(ay)?|sure|go\s*ahead|do\s*it|proceed|confirm(ed)?|approved?|lgtm|sounds?\s*good|that('?s| is)\s*(fine|good|correct|right)|please(\s*do)?|yea|aye|k)\s*[.!]?\s*$/i;

export function isPathInDirectory(filePath: string, dirPath: string): boolean {
  const resolved = path.resolve(filePath);
  const dirResolved = path.resolve(dirPath);
  return (
    resolved.startsWith(dirResolved + path.sep) || resolved === dirResolved
  );
}

export function isTrustedPath(filePath: string, projectDir: string): boolean {
  const claudeDir = path.join(os.homedir(), ".claude");
  return (
    isPathInDirectory(filePath, projectDir) ||
    isPathInDirectory(filePath, claudeDir)
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
    path: (input?.file_path as string) ?? (input?.path as string) ?? undefined,
    cmd: (input?.command as string) ?? undefined,
  };
}
