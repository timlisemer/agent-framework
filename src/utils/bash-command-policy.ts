/**
 * Shared Bash command policy, risk classification, blacklist highlights, and
 * workaround detection.
 *
 * BLACKLIST_PATTERNS: Hard safety denials owned by the blacklist rule
 * CHECK_ROUTED_COMMAND_POLICIES: Commands routed to the check MCP by tool-approve
 * WORKAROUND_PATTERNS: Used by pre-tool-use to detect repeated denial attempts
 * CHECK_EQUIVALENTS: Maps check-routed policy names to equivalent check targets
 */

import { resolveCheckMessage } from "./check-target-context.js";
import { redactPathTokens } from "./path-redaction.js";
import { activeSpec } from "../adapter/spec.js";

function checkMcpAction(): string {
  return `You must run the ${activeSpec().renderCheckMcpHint()}`;
}

const scriptingLanguageAction = "Scripting language execution denied. Use dedicated internal tools and read-only Bash commands instead.";

function gitWorkflowAlternative(): string {
  const spec = activeSpec();
  const commit = spec.renderWorkflowInvocation("commit");
  const push = spec.renderWorkflowInvocation("push");
  const quickpush = spec.renderWorkflowInvocation("quickpush");
  return `Use workflow tools (${commit}, ${push}, or ${quickpush})`;
}

export interface BlacklistPattern {
  pattern: RegExp;
  // Optional stricter regex used only by getContentBlacklistHighlights.
  // Lets an entry stay loose for Bash (where the input is always a
  // shell command) while requiring shape evidence (a flag or a
  // `<PATH>` redaction marker) when scanning plan / CLAUDE.md prose,
  // so prose words like "node with" or "tail events" do not match.
  contentPattern?: RegExp;
  name: string;
  /** Static string or lazy getter called at lookup time (for adapter-dynamic alternatives). */
  alternative: string | (() => string);
  bashOnly?: boolean;
  redactPaths?: boolean;
}

export type CheckRoutedCategory = "type-check" | "build" | "lint" | "format" | "test";

export interface CheckRoutedCommandPolicy {
  pattern: RegExp;
  contentPattern?: RegExp;
  name: string;
  category: CheckRoutedCategory;
  variants: string[];
  equivalents: string[];
  bashOnly?: boolean;
  redactPaths?: boolean;
}

/** Resolve a BlacklistPattern alternative to a string. */
function resolveAlternative(alt: string | (() => string)): string {
  return typeof alt === "function" ? alt() : alt;
}

export type BashCommandRiskClass =
  | "blocked"
  | "simple-read-only"
  | "read-only-heavy"
  | "read-only-complex"
  | "high-risk-workaround"
  | "non-read-only-non-workaround";

export interface BashCommandClassification {
  riskClass: BashCommandRiskClass;
  readOnly: boolean;
  reason?: string;
  alternative?: string;
  commandHead?: string;
  workaroundCategory?: string;
  blacklistHighlights: string[];
  predictionIdentities: string[];
}

/**
 * Hard safety patterns that should be blocked by the blacklist rule.
 * Check-MCP redirects live in CHECK_ROUTED_COMMAND_POLICIES so their
 * PreToolUse attribution remains tool-approve instead of blacklist.
 */
export const BLACKLIST_PATTERNS: BlacklistPattern[] = [
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
  { pattern: /\bgit\s+(commit|push|add)\b/, name: 'git write op (MCP)', alternative: gitWorkflowAlternative },
  { pattern: /\bgit\s+(?:am|apply|bisect|checkout|cherry-pick|clean|clone|fetch|gc|merge|mv|pull|rebase|reflog|remote|reset|restore|revert|rm|stash|submodule|switch|tag|worktree)\b/, name: 'git write op', alternative: 'Git write operation denied' },

  // Package install commands - dependency-modifying, should not be run by AI
  { pattern: /\bnpm\s+install\b/, name: "npm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bbun\s+install\b/, name: "bun install", alternative: "LLMs should not modify project dependencies", redactPaths: true },
  { pattern: /\bpnpm\s+install\b/, name: "pnpm install", alternative: "LLMs should not modify project dependencies", redactPaths: true },

  // Command chaining with cd - always deny
  { pattern: /\bcd\s+[^&]+&&/, name: 'cd && chain', alternative: 'Use --cwd flag or run from correct directory' },

  // Nix evaluation - use batch evaluator instead of ad hoc shell evals
  { pattern: /\bnix\s+eval\b/, name: "nix eval", alternative: "Use nix-eval-jobs instead", redactPaths: true },

  // SSH remote execution
  { pattern: /\bssh\s+/, name: 'ssh', alternative: 'Remote execution denied' },

  // Run commands - should not be in plans or CLAUDE.md verification sections
  { pattern: /\bmake\s+run(-\w+)?\b/, name: "make run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bjust\s+run(-\w+)?\b/, name: "just run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bnpm\s+run\s+(start|dev)\b/, name: "npm start/dev", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bbun\s+run\s+(start|dev)\b/, name: "bun start/dev", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bcargo\s+run\b/, name: "cargo run", alternative: "Run commands not allowed", redactPaths: true },
  { pattern: /\bgo\s+run\b/, name: "go run", alternative: "Run commands not allowed", redactPaths: true },

  // Code execution commands - denied as shell scripting language execution.
  // node contentPattern matches when the verb is at line start (after optional
  // indent / bullet / numbered-list marker), OR when the next token is a flag
  // or redacted <PATH> argument. Bare-prose use ("submenu node with ...") no
  // longer fires.
  { pattern: /(?:^|[\s;&|])python(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?python\s+\S|\bpython\s+(?:-[\w-]+|<PATH>))/, name: "python", alternative: scriptingLanguageAction, redactPaths: true },
  { pattern: /(?:^|[\s;&|])python3(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?python3\s+\S|\bpython3\s+(?:-[\w-]+|<PATH>))/, name: "python3", alternative: scriptingLanguageAction, redactPaths: true },
  { pattern: /(?:^|[\s;&|])node(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?node\s+\S|\bnode\s+(?:-[\w-]+|<PATH>))/, name: "node", alternative: scriptingLanguageAction, redactPaths: true },
  { pattern: /(?:^|[\s;&|])ruby(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?ruby\s+\S|\bruby\s+(?:-[\w-]+|<PATH>))/, name: "ruby", alternative: scriptingLanguageAction, redactPaths: true },
  { pattern: /(?:^|[\s;&|])perl(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?perl\s+\S|\bperl\s+(?:-[\w-]+|<PATH>))/, name: "perl", alternative: scriptingLanguageAction, redactPaths: true },
];

export const CHECK_ROUTED_COMMAND_POLICIES: CheckRoutedCommandPolicy[] = [
  { pattern: /^make\s+check\b/, name: "make check", category: "type-check", variants: ["make check"], equivalents: ["check"], redactPaths: true },
  { pattern: /^just\s+check\b/, name: "just check", category: "type-check", variants: ["just check"], equivalents: ["check"], redactPaths: true },
  { pattern: /^npm\s+run\s+(?:check|typecheck)\b/, name: "npm check/typecheck", category: "type-check", variants: ["npm run check", "npm run typecheck"], equivalents: ["tsc", "npx tsc", "typecheck"], redactPaths: true },
  { pattern: /^pnpm\s+(?:run\s+)?(?:check|typecheck)\b/, name: "pnpm check/typecheck", category: "type-check", variants: ["pnpm check", "pnpm run check", "pnpm typecheck", "pnpm run typecheck"], equivalents: ["tsc", "npx tsc", "typecheck"], redactPaths: true },
  { pattern: /^yarn\s+(?:run\s+)?(?:check|typecheck)\b/, name: "yarn check/typecheck", category: "type-check", variants: ["yarn check", "yarn run check", "yarn typecheck", "yarn run typecheck"], equivalents: ["tsc", "npx tsc", "typecheck"], redactPaths: true },
  { pattern: /^bun\s+run\s+(?:check|typecheck)\b/, name: "bun check/typecheck", category: "type-check", variants: ["bun run check", "bun run typecheck"], equivalents: ["tsc", "typecheck"], redactPaths: true },
  { pattern: /^cargo\s+check\b/, name: "cargo check", category: "type-check", variants: ["cargo check"], equivalents: ["cargo check", "cargo clippy"], redactPaths: true },
  { pattern: /^(?:npx\s+)?tsc\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?(?:npx\s+)?tsc\b|\bnpx\s+tsc\b|\btsc\s+(?:-[\w-]+|<PATH>))/, name: "tsc", category: "type-check", variants: ["tsc", "npx tsc"], equivalents: ["tsc", "npx tsc"], redactPaths: true },

  { pattern: /^make\s+build\b/, name: "make build", category: "build", variants: ["make build"], equivalents: ["make build", "cargo check", "tsc"], redactPaths: true },
  { pattern: /^just\s+build\b/, name: "just build", category: "build", variants: ["just build"], equivalents: ["just build", "cargo check", "tsc"], redactPaths: true },
  { pattern: /^npm\s+run\s+build\b/, name: "npm build", category: "build", variants: ["npm run build"], equivalents: ["tsc", "npx tsc", "npm run build"], redactPaths: true },
  { pattern: /^pnpm\s+(?:run\s+)?build\b/, name: "pnpm build", category: "build", variants: ["pnpm build", "pnpm run build"], equivalents: ["tsc", "pnpm build", "pnpm run build"], redactPaths: true },
  { pattern: /^yarn\s+(?:run\s+)?build\b/, name: "yarn build", category: "build", variants: ["yarn build", "yarn run build"], equivalents: ["tsc", "yarn build", "yarn run build"], redactPaths: true },
  { pattern: /^bun\s+run\s+build\b/, name: "bun build", category: "build", variants: ["bun run build"], equivalents: ["tsc", "bun run build"], redactPaths: true },
  { pattern: /^cargo\s+build\b/, name: "cargo build", category: "build", variants: ["cargo build"], equivalents: ["cargo check", "cargo clippy"], redactPaths: true },

  { pattern: /^cargo\s+clippy\b/, name: "cargo clippy", category: "lint", variants: ["cargo clippy"], equivalents: ["cargo clippy"], redactPaths: true },
  { pattern: /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+lint\b/, name: "lint command", category: "lint", variants: ["npm run lint", "pnpm lint", "pnpm run lint", "yarn lint", "yarn run lint", "bun run lint"], equivalents: ["eslint", "lint", "prettier"], redactPaths: true },
  { pattern: /^eslint\b/, name: "eslint", category: "lint", variants: ["eslint"], equivalents: ["eslint", "lint"], redactPaths: true },

  { pattern: /^(?:(?:npx\s+)?(?:vitest|jest|mocha|ava)|pytest|(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?test|(?:npx|cargo)\s+test)\b/, name: "test command", category: "test", variants: ["test", "vitest", "npx vitest", "jest", "npx jest", "mocha", "npx mocha", "pytest", "ava", "npx ava", "npm test", "npm run test", "yarn test", "yarn run test", "pnpm test", "pnpm run test", "bun test", "bun run test", "npx test", "cargo test"], equivalents: ["vitest", "jest", "pytest", "cargo test", "test", "mocha", "ava"], bashOnly: true, redactPaths: true },

  { pattern: /^cargo\s+fmt\b/, name: "cargo fmt", category: "format", variants: ["cargo fmt"], equivalents: ["cargo fmt", "rustfmt", "fmt", "format", "check"], redactPaths: true },
  { pattern: /^rustfmt\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?rustfmt\b|\brustfmt\s+(?:-[\w-]+|<PATH>))/, name: "rustfmt", category: "format", variants: ["rustfmt"], equivalents: ["rustfmt", "cargo fmt", "fmt", "format", "check"], redactPaths: true },
  { pattern: /^(?:npx\s+)?prettier\b/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?(?:npx\s+)?prettier\b|\bprettier\s+(?:-[\w-]+|<PATH>))/, name: "prettier", category: "format", variants: ["prettier", "npx prettier"], equivalents: ["prettier", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^(?:npm\s+run|pnpm(?:\s+run)?|yarn(?:\s+run)?|bun\s+run)\s+(?:fmt|format)\b/, name: "format command", category: "format", variants: ["npm run fmt", "npm run format", "pnpm fmt", "pnpm run fmt", "pnpm format", "pnpm run format", "yarn fmt", "yarn run fmt", "yarn format", "yarn run format", "bun run fmt", "bun run format"], equivalents: ["prettier", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^(?:make|just)\s+(?:fmt|format)\b/, name: "make/just format", category: "format", variants: ["make fmt", "make format", "just fmt", "just format"], equivalents: ["fmt", "format", "check"], redactPaths: true },
  { pattern: /^(?:npx\s+)?biome\s+(?:format|check)\b/, name: "biome format/check", category: "format", variants: ["biome format", "biome check", "npx biome format", "npx biome check"], equivalents: ["biome format", "biome check", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^dprint\b/, name: "dprint", category: "format", variants: ["dprint"], equivalents: ["dprint", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^treefmt\b/, name: "treefmt", category: "format", variants: ["treefmt"], equivalents: ["treefmt", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^nix\s+fmt\b/, name: "nix fmt", category: "format", variants: ["nix fmt"], equivalents: ["nix fmt", "format", "fmt", "check"], redactPaths: true },
  { pattern: /^alejandra\b/, name: "alejandra", category: "format", variants: ["alejandra"], equivalents: ["alejandra", "format", "fmt", "check"], redactPaths: true },
];

function checkRoutedToBlacklistPattern(policy: CheckRoutedCommandPolicy): BlacklistPattern {
  return {
    pattern: policy.pattern,
    contentPattern: policy.contentPattern,
    name: policy.name,
    alternative: checkMcpAction,
    bashOnly: policy.bashOnly,
    redactPaths: policy.redactPaths,
  };
}

const CHECK_ROUTED_CONTENT_PATTERNS = CHECK_ROUTED_COMMAND_POLICIES.map(checkRoutedToBlacklistPattern);

/**
 * Patterns for detecting workaround attempts (retrying denied commands).
 * Maps pattern category to command substrings that match.
 */
export const WORKAROUND_PATTERNS: Record<string, { variants: string[]; redactPaths?: boolean }> = CHECK_ROUTED_COMMAND_POLICIES
  .reduce<Record<string, { variants: string[]; redactPaths?: boolean }>>((acc, policy) => {
    const existing = acc[policy.category] ?? { variants: [], redactPaths: true };
    existing.variants.push(...policy.variants);
    acc[policy.category] = existing;
    return acc;
  }, {
    install: {
      variants: ["npm install", "bun install", "pnpm install"],
      redactPaths: true,
    },
  });

export function stripQuotedRegions(s: string): string {
  return s.replace(/'[^']*'|"[^"]*"/g, (m) => " ".repeat(m.length));
}

// Commands allowed for read-only Bash use. Shared by Bash policy callers so
// the same inspection/navigation surface stays consistent.
export const READ_ONLY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "tree", "pwd", "dirname", "basename", "realpath", "readlink",
  "cat", "grep", "rg", "find", "fd", "sed", "awk", "nl",
  "wc", "sort", "uniq", "cut", "tr", "diff", "comm",
  "head", "tail",
  "file", "stat",
  "jq", "xargs",
  "which", "type",
  "git",
  "echo", "printf",
]);

export const READ_ONLY_HEAVY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "nix-eval-jobs",
]);

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "blame", "branch", "describe", "diff", "grep", "log", "ls-files",
  "rev-list", "rev-parse", "shortlog", "show", "show-branch", "status",
]);

const XARGS_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-d", "--delimiter",
  "-E", "--eof",
  "-I", "--replace",
  "-n", "--max-args",
  "-P", "--max-procs",
  "-s", "--max-chars",
]);

const READ_ONLY_BASH_COMMAND_LEVEL_DENY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Command/process substitution -- arbitrary-code-execution laundering.
  { pattern: /\$\(|`|<\(|>\(/, reason: "command or process substitution ($(...), backticks, <(...), >(...))" },

  // find destructive flags (GNU + BSD).
  { pattern: /\bfind\b[^|;&]*\s-(delete|exec(dir)?|ok(dir)?|fprint[0f]?|fls)\b/, reason: "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)" },

  // sed in-place editing.
  { pattern: /\bsed\b[^|;&]*\s-i(?:\b|['".A-Za-z0-9_-])/, reason: "sed in-place edit (-i)" },

  // File redirection. Matches `> file`, `>> file`, `1>file`, `>|file`, etc.
  // Excludes `2>&1` / `>&N` via `(?![&(])`, and `/dev/...` targets via `(?!\/dev\/)`.
  // Process substitution is caught by the substitution rule above.
  { pattern: />>?\s*(?!\/dev\/)(?![&(])[^|&(\s]/, reason: "shell redirect to file" },
];

export const PLAN_MODE_BASH_WRITE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(echo|printf)\s+.*>/,
  /\btee\s+/,
  /\bsed\s+-i/,
  /\b(mkdir|touch|rm|mv|cp)\s+/,
  /\bgit\s+(commit|push|add|merge|rebase|reset)\b/,
  /\bnpm\s+(install|run\s+build)\b/,
];

function tokenizeSegment(segment: string): string[] {
  return segment.trim().split(/\s+/).filter(Boolean);
}

export function commandBare(token: string): string {
  return token.startsWith("/") ? token.split("/").pop()! : token;
}

function gitSubcommand(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-C" || token === "-c") {
      i++;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) continue;
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function xargsCommandToken(tokens: string[]): string | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (XARGS_OPTIONS_WITH_VALUE.has(token)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return token;
  }
  return null;
}

function validateReadOnlyCommandHead(tokens: string[]): { allowed: true } | { allowed: false; reason: string } {
  const firstToken = tokens[0];

  // No inline env prefix (closes PATH/LD_PRELOAD injection).
  if (firstToken.includes("=")) {
    return { allowed: false, reason: `inline env assignment not allowed: ${firstToken}` };
  }
  // No relative paths (closes `./grep` laundering where an attacker-controlled
  // binary named `grep` is dropped in cwd).
  if (firstToken.includes("/") && !firstToken.startsWith("/")) {
    return { allowed: false, reason: `relative path execution not allowed: ${firstToken}` };
  }

  const bare = commandBare(firstToken);

  if (READ_ONLY_HEAVY_BASH_COMMANDS.has(bare)) {
    return { allowed: true };
  }

  if (!READ_ONLY_BASH_COMMANDS.has(bare)) {
    return { allowed: false, reason: `command not in read-only allowlist: ${bare}` };
  }

  if (bare === "git") {
    const subcommand = gitSubcommand(tokens);
    if (!subcommand) {
      return { allowed: false, reason: "git command missing read-only subcommand" };
    }
    if (!READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
      return { allowed: false, reason: `git subcommand not in read-only allowlist: ${subcommand}` };
    }
  }

  if (bare === "xargs") {
    const commandToken = xargsCommandToken(tokens);
    if (!commandToken) return { allowed: true };
    return validateReadOnlyCommandHead([commandToken]);
  }

  return { allowed: true };
}

function splitShellSegments(command: string): {
  segments: string[];
  hasComplexOperator: boolean;
  backgrounded: boolean;
} {
  const basis = stripQuotedRegions(command);
  const splitRegex = /\s*(?:\|\||&&|[;|&\n\r])\s*/g;
  const segments: string[] = [];
  let last = 0;
  let hasComplexOperator = false;
  let backgrounded = false;
  for (const m of basis.matchAll(splitRegex)) {
    const operatorText = m[0];
    hasComplexOperator = true;
    if (operatorText.includes("&") && !operatorText.includes("&&")) {
      backgrounded = true;
    }
    segments.push(command.slice(last, m.index));
    last = (m.index ?? 0) + operatorText.length;
  }
  segments.push(command.slice(last));
  return { segments, hasComplexOperator, backgrounded };
}

function contentCommandCandidate(line: string): string {
  return line.trim()
    .replace(/^(?:[-*+>]\s+|\d+\.\s+)/, "")
    .replace(/^(?:run|execute|use)\s+/i, "");
}

function policyTarget(command: string, redactPaths?: boolean): string {
  const quoteStrippedCommand = stripQuotedRegions(command);
  return redactPaths ? redactPathTokens(quoteStrippedCommand) : quoteStrippedCommand;
}

function matchPolicyInCommand(command: string, policy: Pick<CheckRoutedCommandPolicy, "pattern" | "redactPaths">): boolean {
  const target = policyTarget(command, policy.redactPaths);
  return splitShellSegments(target).segments.some((segment) => policy.pattern.test(segment.trim()));
}

function matchPatternInCommand(command: string, pattern: BlacklistPattern): boolean {
  const target = policyTarget(command, pattern.redactPaths);
  return pattern.pattern.test(target);
}

function matchPolicyInContent(line: string, policy: CheckRoutedCommandPolicy, redactedLine: string): boolean {
  const rawCandidate = contentCommandCandidate(line);
  const redactedCandidate = contentCommandCandidate(redactedLine);
  const target = policy.redactPaths ? redactedCandidate : rawCandidate;
  const afterRun = target.replace(/^.*?\brun\s+/i, "");
  const re = policy.contentPattern ?? policy.pattern;
  return re.test(target) ||
    re.test(afterRun) ||
    splitShellSegments(target).segments.some((segment) => policy.pattern.test(segment.trim())) ||
    splitShellSegments(afterRun).segments.some((segment) => policy.pattern.test(segment.trim()));
}

function firstCommandHead(command: string): string | undefined {
  const firstSegment = splitShellSegments(command).segments.find((s) => s.trim());
  if (!firstSegment) return undefined;
  const token = tokenizeSegment(firstSegment)[0];
  return token ? commandBare(token) : undefined;
}

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

  const { segments, backgrounded } = splitShellSegments(trimmed);
  if (backgrounded) {
    return { allowed: false, reason: "background execution (&) is not read-only safe" };
  }

  for (const segment of segments) {
    const seg = segment.trim();
    if (!seg) continue;

    const result = validateReadOnlyCommandHead(tokenizeSegment(seg));
    if (!result.allowed) return result;
  }

  return { allowed: true };
}

export function classifyBashCommand(command: string, workingDir?: string): BashCommandClassification {
  const trimmed = command.trim();
  const commandHead = firstCommandHead(trimmed);

  const base = (riskClass: BashCommandRiskClass, extra: Partial<BashCommandClassification> = {}): BashCommandClassification => ({
    riskClass,
    readOnly: riskClass === "simple-read-only" || riskClass === "read-only-heavy" || riskClass === "read-only-complex",
    commandHead,
    blacklistHighlights: [],
    predictionIdentities: ["Bash", `Bash:${riskClass}`, ...(commandHead ? [`Bash:${commandHead}`] : [])],
    ...extra,
  });

  if (!trimmed) {
    return base("blocked", { reason: "empty command" });
  }

  const matchingPatterns = BLACKLIST_PATTERNS.filter((pattern) => matchPatternInCommand(trimmed, pattern));
  const hardBlacklistHighlights = matchingPatterns.map(({ name, alternative }) => {
    return `[BLACKLIST: ${name}] ${resolveAlternative(alternative)}`;
  });
  const checkRoutedHighlights = getCheckRoutedCommandHighlights("Bash", { command }, workingDir);
  const blacklistHighlights = [...hardBlacklistHighlights, ...checkRoutedHighlights];

  const workaroundCategory = detectWorkaroundCommand(trimmed);
  if (workaroundCategory) {
    return base("high-risk-workaround", {
      workaroundCategory,
      blacklistHighlights,
      reason: `workaround category: ${workaroundCategory}`,
    });
  }

  if (matchingPatterns.length > 0) {
    return base("blocked", {
      blacklistHighlights,
      alternative: matchingPatterns[0] ? resolveAlternative(matchingPatterns[0].alternative) : undefined,
      reason: matchingPatterns[0]?.name,
    });
  }

  for (const { pattern, reason } of READ_ONLY_BASH_COMMAND_LEVEL_DENY) {
    if (pattern.test(trimmed)) {
      return base("blocked", { reason });
    }
  }

  const split = splitShellSegments(trimmed);
  if (split.backgrounded) {
    return base("blocked", { reason: "background execution (&) is not read-only safe" });
  }

  const readOnlyResult = checkReadOnlyBashAllowlist(trimmed);
  if (readOnlyResult.allowed) {
    if (commandHead && READ_ONLY_HEAVY_BASH_COMMANDS.has(commandHead)) {
      return base("read-only-heavy");
    }
    if (split.hasComplexOperator) {
      return base("read-only-complex");
    }
    return base("simple-read-only");
  }

  if (
    readOnlyResult.reason.startsWith("inline env assignment") ||
    readOnlyResult.reason.startsWith("relative path execution") ||
    /\bxargs\b/.test(stripQuotedRegions(trimmed))
  ) {
    return base("blocked", { reason: readOnlyResult.reason });
  }

  return base("non-read-only-non-workaround", { reason: readOnlyResult.reason });
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

export function detectWorkaroundCommand(command: string): string | null {
  for (const [category, { variants, redactPaths: shouldRedact }] of Object.entries(WORKAROUND_PATTERNS)) {
    const target = policyTarget(command, shouldRedact);
    if (variants.some((v) => containsCommandVariant(target, v))) return category;
  }
  return null;
}

/**
 * Maps blacklist pattern names to equivalent commands to search for in check targets.
 * Only patterns that redirect to the agent-framework check MCP need entries here.
 * Used by getBlacklistHighlights to produce context-aware error messages.
 */
export const CHECK_EQUIVALENTS: Record<string, string[]> = Object.fromEntries(
  CHECK_ROUTED_COMMAND_POLICIES.map((policy) => [policy.name, policy.equivalents]),
);

/**
 * Generate formatted blacklist text for injection into agent prompts.
 * Used by plan-validate and claude-md-validate to share rules with tool-approve.
 */
export function getBlacklistDescription(): string {
  return [...BLACKLIST_PATTERNS, ...CHECK_ROUTED_CONTENT_PATTERNS]
    .map(({ name, alternative }) => `- ${name} → ${resolveAlternative(alternative)}`)
    .join("\n");
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
        const altStr = resolveAlternative(alternative);
        const rendered = `[VIOLATION: ${name}] "${line.trim()}" → ${altStr}`;
        highlights.push({
          lineIndex: i,
          line,
          message: altStr,
          rendered,
        });
        break;
      }
    }

    for (const policy of CHECK_ROUTED_COMMAND_POLICIES) {
      if (policy.bashOnly) continue;
      if (matchPolicyInContent(target, policy, redactedTarget)) {
        const altStr = checkMcpAction();
        const rendered = `[VIOLATION: ${policy.name}] "${line.trim()}" → ${altStr}`;
        highlights.push({
          lineIndex: i,
          line,
          message: altStr,
          rendered,
        });
        break;
      }
    }
  }

  return highlights;
}

export function getPolicyContentBlacklistHighlights(
  content: string,
  opts: ContentBlacklistOptions = {},
): BlacklistHighlight[] {
  return getContentBlacklistHighlights(content, opts);
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

  const matchingPatterns = BLACKLIST_PATTERNS.filter((pattern) => matchPatternInCommand(command, pattern));

  const highlights = matchingPatterns
    .map(({ name, alternative }) => {
      return `[BLACKLIST: ${name}] ${resolveAlternative(alternative)}`;
    });
  if (highlights.length > 0) return highlights;

  const classification = classifyBashCommand(command, workingDir);
  if (classification.riskClass === "blocked") {
    return [`[BLACKLIST: bash blocked] ${classification.alternative ?? classification.reason ?? "Bash command blocked"}`];
  }
  return [];
}

export function getHardBlacklistHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  return getBlacklistHighlights(toolName, toolInput, workingDir);
}

export function getCheckRoutedCommandHighlights(toolName: string, toolInput: unknown, workingDir?: string): string[] {
  if (toolName !== "Bash") return [];
  const command = (toolInput as { command?: string }).command;
  if (!command) return [];

  return CHECK_ROUTED_COMMAND_POLICIES
    .filter((policy) => matchPolicyInCommand(command, policy))
    .map((policy) => {
      const msg = workingDir
        ? resolveCheckMessage(policy.name, policy.equivalents, workingDir)
        : checkMcpAction();
      return `[CHECK-ROUTED: ${policy.name}] ${msg}`;
    });
}

export function detectCheckRoutedWorkaroundCommand(command: string): string | null {
  return detectWorkaroundCommand(command);
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
  return detectWorkaroundCommand(command);
}
