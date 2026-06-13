import { commandBare, splitShellSegments, stripQuotedRegions, tokenizeSegment } from "../analysis.js";
import { hasActiveCommandOrProcessSubstitution } from "../analysis.js";
import { validateReadOnlyGitCommand } from "./git.js";
import {
  FIND_DESTRUCTIVE_DENY_REASON,
  SED_IN_PLACE_DENY_REASON,
  hasFindDestructiveFlag,
  hasSedInPlaceFlag,
  tokensHaveFindDestructiveFlag,
  tokensHaveSedInPlaceFlag,
} from "./find-sed.js";
import { SHELL_REDIRECT_DENY_REASON } from "./file-write.js";
import { hasActiveFileRedirect } from "../analysis.js";
import { xargsCommandTokens } from "../../shell-command-parser.js";
import { READ_ONLY_BASH_COMMANDS } from "./read-only-commands.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";

export { READ_ONLY_BASH_COMMANDS };

export const READ_ONLY_HEAVY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "nix-eval-jobs",
]);

export const COMMAND_SUBSTITUTION_DENY_REASON = "command or process substitution ($(...), backticks, <(...), >(...))";

export const READ_ONLY_HARD_PATTERNS: BlacklistPattern[] = [
  { pattern: /\bcd\s+/, name: "cd", alternative: "Use absolute paths", topic: "read-only" },
  { pattern: /\bcd\s+[^&]+&&/, name: "cd && chain", alternative: "Use --cwd flag or run from correct directory", topic: "read-only" },
  { pattern: /\bnix\s+eval\b/, name: "nix eval", alternative: "Use nix-eval-jobs instead", redactPaths: true, topic: "read-only" },
];

interface ReadOnlyBashCommandLevelDeny {
  reason: string;
  matches(command: string): boolean;
}

const READ_ONLY_BASH_COMMAND_LEVEL_DENY: ReadonlyArray<ReadOnlyBashCommandLevelDeny> = [
  { reason: COMMAND_SUBSTITUTION_DENY_REASON, matches: hasActiveCommandOrProcessSubstitution },
  { reason: FIND_DESTRUCTIVE_DENY_REASON, matches: hasFindDestructiveFlag },
  { reason: SED_IN_PLACE_DENY_REASON, matches: hasSedInPlaceFlag },
  { reason: SHELL_REDIRECT_DENY_REASON, matches: hasActiveFileRedirect },
];

function readOnlyCommandLevelDenyReasonInternal(command: string): string | null {
  for (const { reason, matches } of READ_ONLY_BASH_COMMAND_LEVEL_DENY) {
    if (matches(command)) return reason;
  }
  return null;
}

export function readOnlyCommandLevelDenyReason(command: string): string | null {
  return readOnlyCommandLevelDenyReasonInternal(command);
}

function validateReadOnlyCommandHead(tokens: string[]): { allowed: true } | { allowed: false; reason: string } {
  const firstToken = tokens[0];

  if (firstToken.includes("=")) {
    return { allowed: false, reason: `inline env assignment not allowed: ${firstToken}` };
  }
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
    const gitResult = validateReadOnlyGitCommand(tokens);
    if (!gitResult.allowed) return gitResult;
  }

  if (bare === "find" && tokensHaveFindDestructiveFlag(tokens)) {
    return { allowed: false, reason: FIND_DESTRUCTIVE_DENY_REASON };
  }

  if (bare === "sed" && tokensHaveSedInPlaceFlag(tokens)) {
    return { allowed: false, reason: SED_IN_PLACE_DENY_REASON };
  }

  if (bare === "xargs") {
    const commandTokens = xargsCommandTokens(tokens);
    if (!commandTokens) return { allowed: true };
    return validateReadOnlyCommandHead(commandTokens);
  }

  return { allowed: true };
}

export function checkReadOnlyBashAllowlist(command: string): { allowed: true } | { allowed: false; reason: string } {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "empty command" };
  }

  const commandLevelDeny = readOnlyCommandLevelDenyReasonInternal(trimmed);
  if (commandLevelDeny) {
    return { allowed: false, reason: commandLevelDeny };
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

function isReadOnlyGuardDeny(command: string, reason: string): boolean {
  return reason === COMMAND_SUBSTITUTION_DENY_REASON ||
    reason === FIND_DESTRUCTIVE_DENY_REASON ||
    reason === SED_IN_PLACE_DENY_REASON ||
    reason === SHELL_REDIRECT_DENY_REASON ||
    reason === "background execution (&) is not read-only safe" ||
    reason.startsWith("inline env assignment") ||
    reason.startsWith("relative path execution") ||
    /\bxargs\b/.test(stripQuotedRegions(command));
}

export function readOnlyPolicyFindings(command: string): BashPolicyFinding[] {
  const result = checkReadOnlyBashAllowlist(command);
  if (result.allowed) {
    return [{
      topic: "read-only",
      role: "terminal-candidate",
      kind: "allow",
      name: "read-only",
      reason: "read-only Bash command",
    }];
  }

  if (isReadOnlyGuardDeny(command, result.reason)) {
    return [{
      topic: "read-only",
      role: "terminal-candidate",
      kind: "deny",
      name: "read-only guard",
      reason: result.reason,
    }];
  }

  return [{
    topic: "read-only",
    role: "observation",
    kind: "classification",
    name: "non-read-only",
    reason: result.reason,
  }];
}
