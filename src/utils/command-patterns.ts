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
  // Optional stricter regex used only by getContentBlacklistHighlights.
  // Lets an entry stay loose for Bash (where the input is always a
  // shell command) while requiring shape evidence (a flag or a
  // `<PATH>` redaction marker) when scanning plan / CLAUDE.md prose,
  // so prose words like "node with" or "tail events" do not match.
  contentPattern?: RegExp;
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
  { pattern: /\bcat\s+/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?cat\s+\S|\bcat\s+(?:-[\w-]+|<PATH>))/, name: 'cat', alternative: 'Use Read tool', redactPaths: true },
  { pattern: /\bhead\s+/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?head\s+\S|\bhead\s+(?:-[\w-]+|\+?\d+|<PATH>))/, name: 'head', alternative: 'Use Read tool with limit', redactPaths: true },
  { pattern: /\btail\s+/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?tail\s+\S|\btail\s+(?:-[\w-]+|\+?\d+|<PATH>))/, name: 'tail', alternative: 'Use Read tool with offset', redactPaths: true },

  // grep/rg/find intentionally NOT blacklisted: native macOS/Linux Claude Code
  // builds removed the Grep/Glob tools in v2.1.117 and route search through
  // bash (bundled ugrep/bfs), so blocking them leaves no search mechanism.

  // File writing - should use Write tool
  { pattern: /\becho\s+.*>/, name: 'echo redirect', alternative: 'Use Write tool' },

  // Directory change - always deny
  { pattern: /\bcd\s+/, name: 'cd', alternative: 'Use absolute paths' },

  // Git write operations. Keep this list explicit: read-only commands like
  // `git status`, `git diff`, `git log`, and `git show` must remain usable
  // for inspection.
  { pattern: /\bgit\s+(commit|push|add)\b/, name: 'git write op (MCP)', alternative: 'Use MCP tools: /commit, /push, or /quickpush' },
  { pattern: /\bgit\s+(?:am|apply|bisect|checkout|cherry-pick|clean|clone|fetch|gc|merge|mv|pull|rebase|reflog|remote|reset|restore|revert|rm|stash|submodule|switch|tag|worktree)\b/, name: 'git write op', alternative: 'Git write operation denied' },

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
  { pattern: /\b(tsc|npx\s+tsc)\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?(?:npx\s+)?tsc\b|\bnpx\s+tsc\b|\btsc\s+(?:-[\w-]+|<PATH>))/, name: "tsc", alternative: "You must run mcp__agent-framework__check", redactPaths: true },

  // Package install commands - dependency-modifying, should not be run by AI
  { pattern: /\bnpm\s+install\b/, name: "npm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bbun\s+install\b/, name: "bun install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bpnpm\s+install\b/, name: "pnpm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },

  // Lint commands - should use check tool
  { pattern: /\bnpm\s+run\s+lint\b/, name: "npm lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bbun\s+run\s+lint\b/, name: "bun lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bpnpm\s+(run\s+)?lint\b/, name: "pnpm lint", alternative: "You must run mcp__agent-framework__check", redactPaths: true },

  // Test commands - tests may not exist, use check for build verification
  // bashOnly: dedicated runners are caught by their own bare names; bare-word
  // "test" is only allowed when prefixed by a package manager (npm/yarn/pnpm/
  // bun with optional `run`, or npx/cargo). The bare-word form was previously
  // a bare alternation (\b(test|...)\b) which over-matched the literal "test"
  // inside *.test.ts / foo.test.ts arguments to commands like
  // `find -name "*.test.ts"` because path-redaction does not strip tokens
  // whose only path signal is a trailing .ext-followed-by-quote
  // (PATH_EXTENSION trails on $|:|,|; only). The (?:run\s+)? particle is the
  // canonical npm/yarn/pnpm/bun form (the repo's own package.json uses
  // `npm run test` via scripts.test) and mirrors the existing convention at
  // lines 50/52/63/64 (npm run check/typecheck, bun run check/typecheck, etc.)
  { pattern: /\b(?:vitest|jest|mocha|pytest|ava|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test|(?:npx|cargo)\s+test)\b/, name: "test command", alternative: "You must run mcp__agent-framework__check", bashOnly: true, redactPaths: true },

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

  // Code execution commands - should be added to Justfile/Makefile check target.
  // node contentPattern matches when the verb is at line start (after optional
  // indent / bullet / numbered-list marker), OR when the next token is a flag
  // or redacted <PATH> argument. Bare-prose use ("submenu node with ...") no
  // longer fires.
  { pattern: /\bpython\s+(-c\s+)?/, name: "python", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bpython3\s+(-c\s+)?/, name: "python3", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
  { pattern: /\bnode\s+(-e\s+)?/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?node\s+\S|\bnode\s+(?:-[\w-]+|<PATH>))/, name: "node", alternative: "You must run mcp__agent-framework__check", redactPaths: true },
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

function stripQuotedRegions(s: string): string {
  return s.replace(/'[^']*'|"[^"]*"/g, (m) => " ".repeat(m.length));
}

// Commands allowed for read-only Bash use. Shared by subagent gating and
// prediction-block so the same inspection/navigation surface stays consistent.
export const READ_ONLY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "tree", "pwd", "dirname", "basename", "realpath", "readlink",
  "grep", "rg", "find", "fd",
  "wc", "sort", "uniq", "cut", "tr", "diff", "comm",
  "head", "tail",
  "file", "stat",
  "jq",
  "which", "type",
  "echo", "printf",
]);

const READ_ONLY_BASH_COMMAND_LEVEL_DENY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Command/process substitution -- arbitrary-code-execution laundering.
  { pattern: /\$\(|`|<\(|>\(/, reason: "command or process substitution ($(...), backticks, <(...), >(...))" },

  // find destructive flags (GNU + BSD).
  { pattern: /\bfind\b[^|;&]*\s-(delete|exec(dir)?|ok(dir)?|fprint[0f]?|fls)\b/, reason: "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)" },

  // File redirection. Matches `> file`, `>> file`, `1>file`, `>|file`, etc.
  // Excludes `2>&1` / `>&N` via `(?![&(])`, and `/dev/...` targets via `(?!\/dev\/)`.
  // Process substitution is caught by the substitution rule above.
  { pattern: />>?\s*(?!\/dev\/)(?![&(])[^|&(\s]/, reason: "shell redirect to file" },
];

export function checkReadOnlyBashAllowlist(command: string): { allowed: true } | { allowed: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty command" };
  }

  for (const { pattern, reason } of READ_ONLY_BASH_COMMAND_LEVEL_DENY) {
    if (pattern.test(trimmed)) {
      return { allowed: false, reason };
    }
  }

  // Split on shell control operators. Use quote-stripped basis for split positions
  // so shell metachars inside quoted args (e.g. `grep 'a; b' file`) don't cause
  // spurious segment boundaries.
  const basis = stripQuotedRegions(trimmed);
  const splitRegex = /\s*(?:\|\||&&|[;|&\n\r])\s*/g;
  const segments: string[] = [];
  let last = 0;
  for (const m of basis.matchAll(splitRegex)) {
    segments.push(trimmed.slice(last, m.index));
    last = (m.index ?? 0) + m[0].length;
  }
  segments.push(trimmed.slice(last));

  for (const segment of segments) {
    const seg = segment.trim();
    if (!seg) continue;

    const firstToken = seg.split(/\s+/)[0];

    // No inline env prefix (closes PATH/LD_PRELOAD injection).
    if (firstToken.includes("=")) {
      return { allowed: false, reason: `inline env assignment not allowed: ${firstToken}` };
    }
    // No relative paths (closes `./grep` laundering where a subagent drops an
    // attacker-controlled binary named `grep` in cwd).
    if (firstToken.includes("/") && !firstToken.startsWith("/")) {
      return { allowed: false, reason: `relative path execution not allowed: ${firstToken}` };
    }

    const bare = firstToken.startsWith("/") ? firstToken.split("/").pop()! : firstToken;

    if (!READ_ONLY_BASH_COMMANDS.has(bare)) {
      return { allowed: false, reason: `command not in read-only allowlist: ${bare}` };
    }
  }

  return { allowed: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsCommandVariant(command: string, variant: string): boolean {
  const trimmed = variant.trim();
  if (!trimmed) return false;
  const escaped = escapeRegExp(trimmed).replace(/\\\s+/g, "\\s+");
  const re = new RegExp(`(?:^|[\\s;&|])${escaped}(?=$|[\\s;&|])`);
  return re.test(command);
}

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

    for (const { pattern, contentPattern, name, alternative, bashOnly, redactPaths: shouldRedact } of BLACKLIST_PATTERNS) {
      if (bashOnly) continue;
      const t = shouldRedact ? redactedTarget : target;
      // Prefer the stricter content-mode regex when the entry defines one;
      // it requires shape evidence (a flag or `<PATH>` token) that prose
      // word-pairs like "node with" or "tail events" don't have.
      const re = contentPattern ?? pattern;
      if (re.test(t)) {
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

  // File-reading patterns (cat/head/tail) match only when one of those
  // binaries is the EXECUTABLE HEAD of a sequence segment — never an
  // incidental occurrence inside an argument or string literal (e.g.
  // `node -e 'console.log("the tail value")'`). Sequence separators
  // that spawn a fresh executable: ;, &&, ||, & (background). The
  // `&(?!\d)` lookahead avoids splitting on shell redirection like
  // `2>&1`. Pipe `|` is NOT a separator: `ls | head -5` is output
  // truncation, not file reading. Quoted spans are stripped before
  // splitting so separators inside string literals don't fragment the
  // command. Accepted trade-off: wrapper prefixes (`sudo tail`,
  // `nohup tail`, `time cat`), backtick / $(…) substitutions, and
  // `bash -c "tail …"` shell-escapes are no longer caught here — none
  // had a test or scenario depending on the previous incidental match.
  const quoteStrippedCommand = stripQuotedRegions(command);
  const FILE_READING_PATTERN_NAMES = new Set(["cat", "head", "tail"]);
  const segmentHeads = quoteStrippedCommand
    .split(/&&|\|\||;|&(?!\d)/)
    .map((seg) => seg.trim().split(/\s+/)[0])
    .filter((head) => head.length > 0);
  const redactedCommand = redactPathTokens(quoteStrippedCommand);

  return BLACKLIST_PATTERNS
    .filter(({ pattern, name, redactPaths: shouldRedact }) => {
      if (FILE_READING_PATTERN_NAMES.has(name)) {
        // Append a trailing space so the pattern's required `\s+`
        // matches a bare-word head. The verb itself has no path tokens,
        // so redactPaths is a no-op for these patterns.
        return segmentHeads.some((head) => pattern.test(head + " "));
      }
      const target = shouldRedact ? redactedCommand : quoteStrippedCommand;
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
  const quoteStrippedCommand = stripQuotedRegions(command);
  const redacted = redactPathTokens(quoteStrippedCommand);
  for (const [category, { variants, redactPaths: shouldRedact }] of Object.entries(WORKAROUND_PATTERNS)) {
    const target = shouldRedact ? redacted : quoteStrippedCommand;
    if (variants.some((v) => containsCommandVariant(target, v))) return category;
  }
  return null;
}
