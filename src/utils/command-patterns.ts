/**
 * Shared command patterns for detecting blacklisted commands and workaround attempts.
 *
 * BLACKLIST_PATTERNS: Used by tool-approve to highlight bad bash commands to the LLM
 * WORKAROUND_PATTERNS: Used by pre-tool-use to detect repeated denial attempts
 * CHECK_EQUIVALENTS: Maps pattern names to equivalent commands found in check targets
 */

import { resolveCheckMessage } from "./check-target-context.js";

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
  { pattern: /\bgit\s+(commit|push|add)\b/, name: 'git write op (MCP)', alternative: 'Use MCP tools: /commit, /push, or /quickpush' },
  { pattern: /\bgit\s+(?!commit|push|add)\w+/, name: 'git write op', alternative: 'Git write operation denied' },

  // Build/check commands - LLMs should NOT build, only verify with check tool
  { pattern: /\bmake\s+check\b/, name: "make check", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bjust\s+check\b/, name: "just check", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bmake\s+build\b/, name: "make build", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bjust\s+build\b/, name: "just build", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bnpm\s+run\s+build\b/, name: "npm build", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bnpm\s+run\s+(check|typecheck)\b/, name: "npm check/typecheck", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bbun\s+run\s+build\b/, name: "bun build", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bbun\s+run\s+(check|typecheck)\b/, name: "bun check/typecheck", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bcargo\s+build\b/, name: "cargo build", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bcargo\s+check\b/, name: "cargo check", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\b(tsc|npx\s+tsc)\b/, name: "tsc", alternative: "You must run mcp__agent-framework__check" },

  // Package install commands - dependency-modifying, should not be run by AI
  { pattern: /\bnpm\s+install\b/, name: "npm install", alternative: "LLMs should not modify project dependencies" },
  { pattern: /\bbun\s+install\b/, name: "bun install", alternative: "LLMs should not modify project dependencies" },
  { pattern: /\bpnpm\s+install\b/, name: "pnpm install", alternative: "LLMs should not modify project dependencies" },

  // Lint commands - should use check tool
  { pattern: /\bnpm\s+run\s+lint\b/, name: "npm lint", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bbun\s+run\s+lint\b/, name: "bun lint", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bpnpm\s+(run\s+)?lint\b/, name: "pnpm lint", alternative: "You must run mcp__agent-framework__check" },

  // Test commands - tests may not exist, use check for build verification
  { pattern: /\b(test|vitest|jest|mocha|pytest|ava)\b/, name: "test command", alternative: "You must run mcp__agent-framework__check" },

  // Command chaining with cd - always deny
  { pattern: /\bcd\s+[^&]+&&/, name: 'cd && chain', alternative: 'Use --cwd flag or run from correct directory' },

  // Nix formatting - should use check tool
  { pattern: /\balejandra\b/, name: "alejandra", alternative: "You must run mcp__agent-framework__check" },

  // SSH remote execution
  { pattern: /\bssh\s+/, name: 'ssh', alternative: 'Remote execution denied' },

  // Run commands - should not be in plans or CLAUDE.md verification sections
  { pattern: /\bmake\s+run(-\w+)?\b/, name: "make run", alternative: "Run commands not allowed" },
  { pattern: /\bjust\s+run(-\w+)?\b/, name: "just run", alternative: "Run commands not allowed" },
  { pattern: /\bnpm\s+run\s+(start|dev)\b/, name: "npm start/dev", alternative: "Run commands not allowed" },
  { pattern: /\bbun\s+run\s+(start|dev)\b/, name: "bun start/dev", alternative: "Run commands not allowed" },
  { pattern: /\bcargo\s+run\b/, name: "cargo run", alternative: "Run commands not allowed" },
  { pattern: /\bgo\s+run\b/, name: "go run", alternative: "Run commands not allowed" },

  // Code execution commands - should be added to Justfile/Makefile check target
  { pattern: /\bpython\s+(-c\s+)?/, name: "python", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bpython3\s+(-c\s+)?/, name: "python3", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bnode\s+(-e\s+)?/, name: "node", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bruby\s+(-e\s+)?/, name: "ruby", alternative: "You must run mcp__agent-framework__check" },
  { pattern: /\bperl\s+(-e\s+)?/, name: "perl", alternative: "You must run mcp__agent-framework__check" },
];

/**
 * Patterns for detecting workaround attempts (retrying denied commands).
 * Maps pattern category to command substrings that match.
 */
export const WORKAROUND_PATTERNS: Record<string, string[]> = {
  "type-check": [
    "make check",
    "just check",
    "tsc",
    "npx tsc",
    "npm run check",
    "npm run typecheck",
    "bun run check",
    "bun run typecheck",
    "cargo check",
  ],
  build: ["make build", "just build", "npm run build", "bun run build", "cargo build"],
  lint: ["eslint", "prettier", "npm run lint", "bun run lint", "alejandra"],
  test: ["test", "vitest", "jest", "mocha", "pytest", "ava"],
  "code-exec": ["python ", "python3 ", "node ", "ruby ", "perl "],
  install: ["npm install", "bun install", "pnpm install"],
};

/**
 * Maps blacklist pattern names to equivalent commands to search for in check targets.
 * Only patterns that redirect to mcp__agent-framework__check need entries here.
 * Used by getBlacklistHighlights to produce context-aware error messages.
 */
export const CHECK_EQUIVALENTS: Record<string, string[]> = {
  "make check": ["check"],
  "just check": ["check"],
  "make build": ["make build", "cargo check", "tsc"],
  "just build": ["just build", "cargo check", "tsc"],
  "npm build": ["tsc", "npx tsc", "npm run build"],
  "npm check/typecheck": ["tsc", "npx tsc", "typecheck"],
  "bun build": ["tsc", "bun run build"],
  "bun check/typecheck": ["tsc", "typecheck"],
  "cargo build": ["cargo check", "cargo clippy"],
  "cargo check": ["cargo check", "cargo clippy"],
  "tsc": ["tsc", "npx tsc"],
  "npm lint": ["eslint", "lint", "prettier"],
  "bun lint": ["eslint", "lint", "prettier"],
  "pnpm lint": ["eslint", "lint", "prettier"],
  "test command": ["vitest", "jest", "pytest", "cargo test", "test", "mocha", "ava"],
  "alejandra": ["alejandra"],
  "python": ["python", "python3"],
  "python3": ["python", "python3"],
  "node": ["node"],
  "ruby": ["ruby"],
  "perl": ["perl"],
};

/**
 * Generate formatted blacklist text for injection into agent prompts.
 * Used by plan-validate and claude-md-validate to share rules with tool-approve.
 */
export function getBlacklistDescription(): string {
  return BLACKLIST_PATTERNS.map(({ name, alternative }) => `- ${name} → ${alternative}`).join("\n");
}

/**
 * Scan content for blacklisted commands.
 * Returns highlighted violations for injection into agent prompts.
 * Used by plan-validate and claude-md-validate.
 */
export function getContentBlacklistHighlights(content: string): string[] {
  const highlights: string[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;

  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    for (const { pattern, name, alternative } of BLACKLIST_PATTERNS) {
      if (pattern.test(line)) {
        highlights.push(`[VIOLATION: ${name}] "${line.trim()}" → ${alternative}`);
        break; // One highlight per line
      }
    }
  }

  return highlights;
}

/**
 * Get blacklist highlights for a Bash command.
 * Returns array of violation messages for the LLM.
 *
 * When workingDir is provided, produces context-aware messages by checking
 * the project's Justfile/Makefile for command coverage. Falls back to static
 * alternative strings when workingDir is omitted or pattern has no equivalents.
 */
export function getBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  // Block background agents
  if (toolName === "Agent") {
    const input = toolInput as { run_in_background?: boolean };
    if (input.run_in_background === true) {
      return ["[BLACKLIST: background agent] Background agents are not allowed. Use foreground agents only (remove run_in_background or set it to false)."];
    }
    return [];
  }

  if (toolName !== "Bash") return [];
  const command = (toolInput as { command?: string }).command;
  if (!command) return [];

  return BLACKLIST_PATTERNS
    .filter(({ pattern }) => pattern.test(command))
    .map(({ name, alternative }) => {
      const equivalents = CHECK_EQUIVALENTS[name];
      const msg = equivalents && workingDir
        ? resolveCheckMessage(name, equivalents, workingDir)
        : alternative;
      return `[BLACKLIST: ${name}] ${msg}`;
    });
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
