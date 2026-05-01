import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { planModeEditBlock, planModeBashBlock } from "../utils/edit-intent.js";
import { getBlacklistHighlights } from "../utils/command-patterns.js";
import { RESTRICTED_MCP_TOOLS } from "../utils/slash-commands.js";
import { logFastPathApproval } from "../utils/logger.js";

// Commands subagents may invoke via Bash. Default-deny -- anything not listed is denied.
// Deliberately omitted:
//   bash, sh, zsh, dash, ksh, eval, source, ., exec, command (shell laundering)
//   rm, mv, cp, scp, rsync, unlink, shred, truncate, dd (mutation)
//   chmod, chown, ln (permissions / symlinks)
//   kill, killall, pkill (process control)
//   curl, wget, nc, ncat, netcat, socat, fetch (network -- use WebFetch/WebSearch)
//   mkdir, touch, mkfifo, mknod (file creation -- use Write)
//   awk, sed, yq (rich write/exec modes hard to regex-gate safely)
//   python, node, ruby, perl, make, just, cargo, npm, bun, pnpm, tsc (execution)
//   xargs (pipeline laundering into any command)
const SAFE_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "ls", "tree", "pwd", "dirname", "basename", "realpath", "readlink",
  "grep", "rg", "find", "fd",
  "wc", "sort", "uniq", "cut", "tr", "diff", "comm",
  "head", "tail",
  "file", "stat",
  "jq",
  "which", "type",
  "echo", "printf",
]);

// Command-level deny patterns. Match against the full command string so they
// catch destructive flags, substitution, and redirection regardless of segment.
const COMMAND_LEVEL_DENY: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  // Command/process substitution -- arbitrary-code-execution laundering.
  { pattern: /\$\(|`|<\(|>\(/, reason: "command or process substitution ($(...), backticks, <(...), >(...))" },

  // find destructive flags (GNU + BSD).
  { pattern: /\bfind\b[^|;&]*\s-(delete|exec(dir)?|ok(dir)?|fprint[0f]?|fls)\b/, reason: "find destructive flag (-delete/-exec/-execdir/-ok/-okdir/-fprint/-fls)" },

  // File redirection. Matches `> file`, `>> file`, `1>file`, `>|file`, etc.
  // Excludes `2>&1` / `>&N` via `(?![&(])`, and `/dev/...` targets via `(?!\/dev\/)`.
  // Process substitution is caught by the substitution rule above.
  { pattern: />>?\s*(?!\/dev\/)(?![&(])[^|&(\s]/, reason: "shell redirect to file" },
];

// Strip single/double-quoted regions (preserving offsets so splits align).
// Keeps the segmenter quote-aware without a full shell parser.
function stripQuotedRegions(s: string): string {
  return s.replace(/'[^']*'|"[^"]*"/g, (m) => " ".repeat(m.length));
}

function checkSubagentBash(command: string): { allowed: true } | { allowed: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty command" };
  }

  for (const { pattern, reason } of COMMAND_LEVEL_DENY) {
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

    if (!SAFE_BASH_COMMANDS.has(bare)) {
      return { allowed: false, reason: `command not in subagent read-only allowlist: ${bare}` };
    }
  }

  return { allowed: true };
}

export const subagentRule: PreToolRule = {
  name: "subagent",
  displayName: "Subagent",
  priority: 20,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.subagent) {
      return null;
    }

    if (ctx.toolName === "Bash") {
      const command = (ctx.toolInput as { command?: string }).command ?? "";
      const result = checkSubagentBash(command);
      if (!result.allowed) {
        return { fastDeny: `Subagent Bash restricted to read-only commands. ${result.reason}` };
      }
      return { fastAllow: "Subagent read-only Bash approved" };
    }

    // Mirror the four deterministic checks from the old checkToolApproval
    // skipLlmOnClean path. Skipping any of these would allow subagent calls
    // to Edit-in-plan-mode or to restricted MCP tools like
    // mcp__agent-framework__commit to slip through silently.
    if (ctx.planModeCtx.contextString) {
      const input = ctx.toolInput as Record<string, unknown>;
      const filePath = (input?.file_path as string) ?? (input?.path as string) ?? "";
      const editBlock = planModeEditBlock(true, ctx.toolName, filePath);
      if (editBlock) return { fastDeny: editBlock };
      const bashBlock = planModeBashBlock(true, ctx.toolName, (input?.command as string) ?? "");
      if (bashBlock) return { fastDeny: bashBlock };
    }

    const highlights = getBlacklistHighlights(ctx.toolName, ctx.toolInput, ctx.projectDir);
    if (highlights.length > 0) {
      const reason = highlights.map(h => h.replace(/^\[BLACKLIST: [^\]]+\]\s*/, "")).join(". ");
      return { fastDeny: reason };
    }

    if (RESTRICTED_MCP_TOOLS.has(ctx.toolName)) {
      return {
        fastDeny: `${ctx.toolName} requires explicit slash-command authorization (/commit, /push, /confirm, /quickpush, or /check).`,
      };
    }

    logFastPathApproval("subagent", "PreToolUse", ctx.toolName, ctx.projectDir, "Subagent tool approved");
    return { fastAllow: "Subagent tool approved" };
  },
};
