/**
 * Shared command patterns for detecting blacklisted commands and workaround attempts.
 *
 * BLACKLIST_PATTERNS: Used by tool-approve to highlight bad bash commands to the LLM
 * WORKAROUND_PATTERNS: Used by pre-tool-use to detect repeated denial attempts
 * CHECK_EQUIVALENTS: Maps pattern names to equivalent commands found in check targets
 */

import { resolveCheckMessage } from "./check-target-context.js";
import { redactPathTokens } from "./path-redaction.js";

export interface BlacklistPattern {
  pattern: RegExp;
  name: string;
  alternative: string;
  bashOnly?: boolean;
  redactPaths?: boolean;
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

  // grep/rg/find intentionally NOT blacklisted: native macOS/Linux Claude Code
  // builds removed the Grep/Glob tools in v2.1.117 and route search through
  // bash (bundled ugrep/bfs), so blocking them leaves no search mechanism.

  // File writing - should use Write tool
  { pattern: /\becho\s+.*>/, name: 'echo redirect', alternative: 'Use Write tool' },

  // Directory change - always deny
  { pattern: /\bcd\s+/, name: 'cd', alternative: 'Use absolute paths' },

  // Git write operations
  { pattern: /\bgit\s+(commit|push|add)\b/, name: 'git write op (MCP)', alternative: 'Use MCP tools: /commit, /push, or /quickpush' },
  { pattern: /\bgit\s+(?!commit|push|add)\w+/, name: 'git write op', alternative: 'Git write operation denied' },

  // Build/check commands - LLMs should NOT build, only verify with check tool
  { pattern: /\bmake\s+check\b/, name: "make check", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bjust\s+check\b/, name: "just check", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bmake\s+build\b/, name: "make build", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bjust\s+build\b/, name: "just build", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bnpm\s+run\s+build\b/, name: "npm build", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bnpm\s+run\s+(check|typecheck)\b/, name: "npm check/typecheck", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bbun\s+run\s+build\b/, name: "bun build", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bbun\s+run\s+(check|typecheck)\b/, name: "bun check/typecheck", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bcargo\s+build\b/, name: "cargo build", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bcargo\s+check\b/, name: "cargo check", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\b(tsc|npx\s+tsc)\b/, name: "tsc", alternative: "You must run mcp__agent-framework__check", redactPaths: true },

  // Package install commands - dependency-modifying, should not be run by AI
  { pattern: /\bnpm\s+install\b/, name: "npm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bbun\s+install\b/, name: "bun install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bpnpm\s+install\b/, name: "pnpm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },

  // Lint commands - should use check tool
  { pattern: /\bnpm\s+run\s+lint\b/, name: "npm lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bbun\s+run\s+lint\b/, name: "bun lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bpnpm\s+(run\s+)?lint\b/, name: "pnpm lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },

  // Test commands - tests may not exist, use check for build verification
  // bashOnly: the bare word "test" matches prose like "test suite" — only check in Bash commands
  { pattern: /\b(test|vitest|jest|mocha|pytest|ava)\b/, name: "test command", alternative: "You must run mcp__agent-framework__check", bashOnly: true, redactPaths: true },

  // Command chaining with cd - always deny
  { pattern: /\bcd\s+[^&]+&&/, name: 'cd && chain', alternative: 'Use --cwd flag or run from correct directory' },

  // Nix formatting - should use check tool
  { pattern: /\balejandra\b/, name: "alejandra", alternative: "You must run mcp__agent-framework__check", redactPaths: true },

  // SSH remote execution
  { pattern: /\bssh\s+/, name: 'ssh', alternative: 'Remote execution denied' },

  // Run commands - should not be in plans or CLAUDE.md verification sections
  { pattern: /\bmake\s+run(-\w+)?\b/, name: "make run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bjust\s+run(-\w+)?\b/, name: "just run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bnpm\s+run\s+(start|dev)\b/, name: "npm start/dev", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bbun\s+run\s+(start|dev)\b/, name: "bun start/dev", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bcargo\s+run\b/, name: "cargo run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bgo\s+run\b/, name: "go run", alternative: "Run commands not allowed", redactPaths: true },

  // Code execution commands - should be added to Justfile/Makefile check target
  { pattern: /\bpython\s+(-c\s+)?/, name: "python", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bpython3\s+(-c\s+)?/, name: "python3", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bnode\s+(-e\s+)?/, name: "node", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bruby\s+(-e\s+)?/, name: "ruby", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bperl\s+(-e\s+)?/, name: "perl", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
];

/**
 * Patterns for detecting workaround attempts (retrying denied commands).
 * Maps pattern category to command substrings that match.
 */
export const WORKAROUND_PATTERNS: Record<string, { variants: string[]; redactPaths?: boolean }> = {
  "type-check": {
    variants: [
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
    redactPaths: true,
  },
  build: {
    variants: ["make build", "just build", "npm run build", "bun run build", "cargo build"],
    redactPaths: true,
  },
  lint: {
    variants: ["eslint", "prettier", "npm run lint", "bun run lint", "alejandra"],
    redactPaths: true,
  },
  test: {
    variants: ["test", "vitest", "jest", "mocha", "pytest", "ava"],
    redactPaths: true,
  },
  "code-exec": {
    variants: ["python ", "python3 ", "node ", "ruby ", "perl "],
    redactPaths: true,
  },
  install: {
    variants: ["npm install", "bun install", "pnpm install"],
    redactPaths: true,
  },
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

export interface BlacklistHighlight {
  /** 0-based line index in the original content. */
  lineIndex: number;
  /** Raw line text, untrimmed. */
  line: string;
  /** Short message describing the alternative (no severity tag). */
  message: string;
  /** Pre-rendered `[VIOLATION: name] "line" → alternative` string. */
  rendered: string;
}

export interface ContentBlacklistOptions {
  /**
   * When true, scan ONLY inside fenced code blocks. Default false (scan
   * OUTSIDE code blocks — original behavior). CLAUDE.md uses true; plans
   * use the default.
   */
  inverseCodeBlocks?: boolean;
}

/**
 * Scan content for blacklisted commands.
 * Returns highlighted violations for injection into agent prompts.
 * Used by plan-validate and claude-md-validate.
 *
 * The default mode scans OUTSIDE fenced code blocks (commands buried in
 * prose). When `inverseCodeBlocks: true`, scans only INSIDE code blocks
 * (so a `\`\`\`bash\nmake build\n\`\`\`` example in CLAUDE.md is detected).
 */
export function getContentBlacklistHighlights(
  content: string,
  opts: ContentBlacklistOptions = {},
): BlacklistHighlight[] {
  const highlights: BlacklistHighlight[] = [];
  const lines = content.split("\n");
  let inCodeBlock = false;
  const insideOnly = opts.inverseCodeBlocks === true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }

    // Skip lines whose containment doesn't match the requested mode.
    if (insideOnly && !inCodeBlock) continue;
    if (!insideOnly && inCodeBlock) continue;

    let target: string;
    let redactedTarget: string;
    if (insideOnly) {
      // Inside code blocks, the line IS code — don't strip apparent string
      // literals or function calls (those would mask real commands).
      target = line;
      redactedTarget = redactPathTokens(line);
    } else {
      // Outside code blocks, strip references to commands in prose:
      // backticks, double quotes, and function-call expressions like
      // execSync('just build') or spawn("npm run build"). Single quotes
      // alone are NOT stripped (too many false interactions with apostrophes).
      const stripped = line
        .replace(/`[^`]+`/g, "")
        .replace(/"[^"]+"/g, "")
        .replace(/\b\w+\s*\([^)]*\)/g, "");
      target = stripped;
      redactedTarget = redactPathTokens(stripped);
    }

    for (const { pattern, name, alternative, bashOnly, redactPaths: shouldRedact } of BLACKLIST_PATTERNS) {
      if (bashOnly) continue;
      const t = shouldRedact ? redactedTarget : target;
      if (pattern.test(t)) {
        const rendered = `[VIOLATION: ${name}] "${line.trim()}" → ${alternative}`;
        highlights.push({
          lineIndex: i,
          line,
          message: alternative,
          rendered,
        });
        break;
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

  // File-reading patterns should only match the primary command (before any pipe).
  // e.g. "ls | head -5" is output truncation, not file reading.
  const FILE_READING_PATTERN_NAMES = new Set(["cat", "head", "tail"]);
  const primaryCommand = command.split(/\s*\|\s*/)[0];
  const redactedCommand = redactPathTokens(command);
  const redactedPrimary = redactPathTokens(primaryCommand);

  return BLACKLIST_PATTERNS
    .filter(({ pattern, name, redactPaths: shouldRedact }) => {
      const isFileReader = FILE_READING_PATTERN_NAMES.has(name);
      const base = isFileReader ? primaryCommand : command;
      const redacted = isFileReader ? redactedPrimary : redactedCommand;
      const target = shouldRedact ? redacted : base;
      return pattern.test(target);
    })
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
  if (toolName !== "Bash") return null;
  const command = (toolInput as { command?: string }).command ?? "";
  const redacted = redactPathTokens(command);
  for (const [category, { variants, redactPaths: shouldRedact }] of Object.entries(WORKAROUND_PATTERNS)) {
    const target = shouldRedact ? redacted : command;
    if (variants.some((v) => target.includes(v))) return category;
  }
  return null;
}
