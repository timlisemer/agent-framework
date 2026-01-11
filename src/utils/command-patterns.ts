/**
 * Shared command patterns for detecting blacklisted commands and workaround attempts.
 *
 * BLACKLIST_PATTERNS: Used by tool-approve to highlight bad bash commands to the LLM
 * WORKAROUND_PATTERNS: Used by pre-tool-use to detect repeated denial attempts
 */

export interface BlacklistPattern {
  pattern: RegExp;
  name: string;
  alternative: string;
}

/**
 * Patterns that should be blocked and their alternatives.
 * Used by tool-approve agent to highlight violations.
 */
export const BLACKLIST_PATTERNS: BlacklistPattern[] = [
  // File reading - should use Read tool
  { pattern: /\bcat\s+/, name: 'cat', alternative: 'Use Read tool' },
  { pattern: /\bhead\s+/, name: 'head', alternative: 'Use Read tool with limit' },
  { pattern: /\btail\s+/, name: 'tail', alternative: 'Use Read tool with offset' },

  // Search - should use Grep tool
  { pattern: /\b(grep|rg)\s+/, name: 'grep/rg', alternative: 'Use Grep tool' },

  // File finding - should use Glob tool
  { pattern: /\bfind\s+/, name: 'find', alternative: 'Use Glob tool' },

  // File writing - should use Write tool
  { pattern: /\becho\s+.*>/, name: 'echo redirect', alternative: 'Use Write tool' },

  // Directory change - always deny
  { pattern: /\bcd\s+/, name: 'cd', alternative: 'Use absolute paths' },

  // Git write operations
  { pattern: /\bgit\s+(commit|push|add|merge|rebase|reset)\b/, name: 'git write op', alternative: 'Use MCP tools' },

  // Build/check commands
  { pattern: /\bmake\s+(check|build)\b/, name: 'make check/build', alternative: 'Use mcp__agent-framework__check' },
  { pattern: /\bnpm\s+run\s+(build|check|typecheck)\b/, name: 'npm build/check', alternative: 'Use mcp__agent-framework__check' },
  { pattern: /\bbun\s+run\s+(build|check|typecheck)\b/, name: 'bun build/check', alternative: 'Use mcp__agent-framework__check' },
  { pattern: /\bcargo\s+(build|check)\b/, name: 'cargo build/check', alternative: 'Use mcp__agent-framework__check' },
  { pattern: /\b(tsc|npx\s+tsc)\b/, name: 'tsc', alternative: 'Use mcp__agent-framework__check' },

  // Test commands - tests may not exist, use check for build verification
  { pattern: /\btest\b/, name: 'test command', alternative: 'Use mcp__agent-framework__check for build verification' },

  // Command chaining with cd - always deny
  { pattern: /\bcd\s+[^&]+&&/, name: 'cd && chain', alternative: 'Use --cwd flag or run from correct directory' },

  // Nix formatting - should use check tool
  { pattern: /\balejandra\b/, name: 'alejandra', alternative: 'Use mcp__agent-framework__check' },

  // SSH remote execution
  { pattern: /\bssh\s+/, name: 'ssh', alternative: 'Remote execution denied' },

  // Run commands - should not be in plans or CLAUDE.md verification sections
  { pattern: /\bmake\s+run(-\w+)?\b/, name: 'make run', alternative: 'Run commands not allowed' },
  { pattern: /\bnpm\s+run\s+(start|dev)\b/, name: 'npm start/dev', alternative: 'Run commands not allowed' },
  { pattern: /\bbun\s+run\s+(start|dev)\b/, name: 'bun start/dev', alternative: 'Run commands not allowed' },
  { pattern: /\bcargo\s+run\b/, name: 'cargo run', alternative: 'Run commands not allowed' },
  { pattern: /\bgo\s+run\b/, name: 'go run', alternative: 'Run commands not allowed' },
];

/**
 * Patterns for detecting workaround attempts (retrying denied commands).
 * Maps pattern category to command substrings that match.
 */
export const WORKAROUND_PATTERNS: Record<string, string[]> = {
  'type-check': [
    'make check',
    'tsc',
    'npx tsc',
    'npm run check',
    'npm run typecheck',
    'bun run check',
    'bun run typecheck',
    'cargo check',
  ],
  build: ['make build', 'npm run build', 'bun run build', 'cargo build'],
  lint: ['eslint', 'prettier', 'npm run lint', 'bun run lint', 'alejandra'],
  test: ['test'],
};

/**
 * Generate formatted blacklist text for injection into agent prompts.
 * Used by plan-validate and claude-md-validate to share rules with tool-approve.
 */
export function getBlacklistDescription(): string {
  return BLACKLIST_PATTERNS.map(({ name, alternative }) => `- ${name} → ${alternative}`).join("\n");
}

/**
 * Get blacklist highlights for a Bash command.
 * Returns array of violation messages for the LLM.
 */
export function getBlacklistHighlights(toolName: string, toolInput: unknown): string[] {
  if (toolName !== 'Bash') return [];
  const command = (toolInput as { command?: string }).command;
  if (!command) return [];

  return BLACKLIST_PATTERNS.filter(({ pattern }) => pattern.test(command)).map(
    ({ name, alternative }) => `[BLACKLIST: ${name}] ${alternative}`
  );
}

/**
 * Detect if a command matches a workaround pattern category.
 * Returns the pattern category name or null.
 */
export function detectWorkaroundPattern(
  toolName: string,
  toolInput: unknown
): string | null {
  if (toolName !== 'Bash') return null;
  const command = (toolInput as { command?: string }).command || '';

  for (const [pattern, variants] of Object.entries(WORKAROUND_PATTERNS)) {
    if (variants.some((v) => command.includes(v))) {
      return pattern;
    }
  }
  return null;
}
