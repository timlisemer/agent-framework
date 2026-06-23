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
import {
  attachedShortOptionValue,
  canonicalOptionName,
  inlineLongOptionValue,
  optionConsumesSeparateValue,
  XARGS_OPTIONS_WITH_VALUE,
  xargsCommandTokens,
} from "../../shell-command-parser.js";
import { READ_ONLY_BASH_COMMANDS } from "./read-only-commands.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";
import { isSensitivePath } from "../../sensitive-paths.js";

export { READ_ONLY_BASH_COMMANDS };

export const READ_ONLY_HEAVY_BASH_COMMANDS: ReadonlySet<string> = new Set([
  "nix-eval-jobs",
]);

export const COMMAND_SUBSTITUTION_DENY_REASON = "command or process substitution ($(...), backticks, <(...), >(...))";

const SENSITIVE_PATH_OPERAND_COMMANDS: ReadonlySet<string> = new Set([
  "awk",
  "cat",
  "comm",
  "cut",
  "diff",
  "fd",
  "file",
  "find",
  "grep",
  "head",
  "jq",
  "less",
  "ls",
  "more",
  "nl",
  "rg",
  "sed",
  "stat",
  "sort",
  "tail",
  "tree",
  "uniq",
  "wc",
]);

const SEARCH_PATTERN_COMMANDS: ReadonlySet<string> = new Set(["grep", "rg"]);
const EMPTY_OPTION_SET: ReadonlySet<string> = new Set();
const SEARCH_NO_PATTERN_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  rg: new Set(["--files"]),
};
const SEARCH_PATTERN_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  grep: new Set(["-e", "--regexp", "-f", "--file"]),
  rg: new Set(["-e", "--regexp", "-f", "--file"]),
};
const SENSITIVE_OPTION_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  grep: new Set(["-f", "--file", "--include"]),
  rg: new Set(["-f", "--file", "-g", "--glob", "--iglob", "--ignore-file"]),
};
const XARGS_SENSITIVE_OPTION_VALUE_OPTIONS: ReadonlySet<string> = new Set(["-a", "--arg-file"]);
const SEARCH_OPTIONS_WITH_VALUE: Readonly<Record<string, ReadonlySet<string>>> = {
  grep: new Set([
    "-A", "-B", "-C", "-D", "-d", "-e", "-f", "-m",
    "--after-context", "--before-context", "--binary-files", "--context",
    "--devices", "--directories", "--exclude", "--exclude-dir", "--exclude-from",
    "--file", "--include", "--label", "--max-count", "--regexp",
  ]),
  rg: new Set([
    "-A", "-B", "-C", "-E", "-e", "-f", "-g", "-j", "-m", "-r", "-t", "-T",
    "--after-context", "--before-context", "--colors", "--context", "--dfa-size-limit",
    "--encoding", "--engine", "--field-context-separator", "--field-match-separator",
    "--file", "--glob", "--iglob", "--ignore-file", "--max-columns", "--max-count",
    "--max-depth", "--path-separator", "--pre", "--pre-glob", "--regex-size-limit",
    "--regexp", "--replace", "--sort", "--sortr", "--threads", "--type",
    "--type-add", "--type-clear", "--type-not",
  ]),
};

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

  const sensitivePathReason = sensitivePathReadDenyReason(bare, tokens);
  if (sensitivePathReason) {
    return { allowed: false, reason: sensitivePathReason };
  }

  if (bare === "xargs") {
    const xargsSensitivePathReason = sensitiveXargsArgFileDenyReason(tokens);
    if (xargsSensitivePathReason) {
      return { allowed: false, reason: xargsSensitivePathReason };
    }
    const commandTokens = xargsCommandTokens(tokens);
    if (!commandTokens) return { allowed: true };
    return validateReadOnlyCommandHead(commandTokens);
  }

  return { allowed: true };
}

function sensitivePathReadDenyReason(commandHead: string, tokens: string[]): string | null {
  if (!SENSITIVE_PATH_OPERAND_COMMANDS.has(commandHead)) return null;
  const searchOptionsWithValue = SEARCH_OPTIONS_WITH_VALUE[commandHead] ?? EMPTY_OPTION_SET;
  const skipSearchPattern = shouldSkipFirstSearchPattern(commandHead, tokens);
  let skippedSearchPattern = false;
  let parsingOptions = true;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }

    if (parsingOptions && token.startsWith("-")) {
      const inlineValue = inlineLongOptionValue(token);
      if (inlineValue) {
        const reason = sensitiveOptionValueDenyReason(commandHead, inlineValue.option, inlineValue.value);
        if (reason) return reason;
        continue;
      }

      const attachedSensitiveOption = attachedSensitiveOptionValue(commandHead, token, searchOptionsWithValue);
      if (attachedSensitiveOption) {
        const reason = sensitiveOptionValueDenyReason(commandHead, attachedSensitiveOption.option, attachedSensitiveOption.value);
        if (reason) return reason;
        continue;
      }

      const attachedSearchPattern = attachedShortOptionValue(token, "-e", searchOptionsWithValue);
      if (attachedSearchPattern) continue;

      if (optionConsumesSeparateValue(token, searchOptionsWithValue) && i + 1 < tokens.length) {
        const option = canonicalOptionName(token);
        const reason = sensitiveOptionValueDenyReason(commandHead, option, tokens[i + 1] ?? "");
        if (reason) return reason;
        i++;
        continue;
      }

      continue;
    }

    const normalized = normalizeSensitivePathCandidate(token);
    if (skipSearchPattern && !skippedSearchPattern) {
      skippedSearchPattern = true;
      continue;
    }
    if (isSensitivePath(normalized)) return `sensitive path read blocked: ${normalized}`;
  }
  return null;
}

function shouldSkipFirstSearchPattern(commandHead: string, tokens: string[]): boolean {
  if (!SEARCH_PATTERN_COMMANDS.has(commandHead)) return false;
  if (hasNoPatternSearchFlag(commandHead, tokens)) return false;
  return !hasSearchPatternOption(commandHead, tokens);
}

function hasNoPatternSearchFlag(commandHead: string, tokens: string[]): boolean {
  const flags = SEARCH_NO_PATTERN_FLAGS[commandHead];
  return Boolean(flags && tokens.some((token) => flags.has(token)));
}

function hasSearchPatternOption(commandHead: string, tokens: string[]): boolean {
  const patternOptions = SEARCH_PATTERN_VALUE_OPTIONS[commandHead];
  if (!patternOptions) return false;
  return tokens.some((token) => {
    const inlineValue = inlineLongOptionValue(token);
    if (inlineValue && patternOptions.has(inlineValue.option)) return true;
    if (attachedShortOptionValue(token, "-e", SEARCH_OPTIONS_WITH_VALUE[commandHead])) return true;
    if (attachedShortOptionValue(token, "-f", SEARCH_OPTIONS_WITH_VALUE[commandHead])) return true;
    return patternOptions.has(token);
  });
}

function sensitiveOptionValueDenyReason(commandHead: string, option: string, value: string): string | null {
  if (!SENSITIVE_OPTION_VALUE_OPTIONS[commandHead]?.has(option)) return null;
  return sensitivePathValueDenyReason(value);
}

function sensitivePathValueDenyReason(value: string): string | null {
  const normalized = normalizeSensitivePathCandidate(value);
  return isSensitivePath(normalized) ? `sensitive path read blocked: ${normalized}` : null;
}

function sensitiveXargsArgFileDenyReason(tokens: string[]): string | null {
  let parsingOptions = true;
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;
    if (parsingOptions && token === "--") return null;
    if (!parsingOptions || !token.startsWith("-")) return null;

    const inlineValue = inlineLongOptionValue(token);
    if (inlineValue && XARGS_SENSITIVE_OPTION_VALUE_OPTIONS.has(inlineValue.option)) {
      const reason = sensitivePathValueDenyReason(inlineValue.value);
      if (reason) return reason;
      continue;
    }

    const attachedArgFile = attachedShortOptionValue(token, "-a", XARGS_OPTIONS_WITH_VALUE);
    if (attachedArgFile) {
      const reason = sensitivePathValueDenyReason(attachedArgFile);
      if (reason) return reason;
      continue;
    }

    if (optionConsumesSeparateValue(token, XARGS_OPTIONS_WITH_VALUE) && i + 1 < tokens.length) {
      const option = canonicalOptionName(token);
      if (XARGS_SENSITIVE_OPTION_VALUE_OPTIONS.has(option)) {
        const reason = sensitivePathValueDenyReason(tokens[i + 1] ?? "");
        if (reason) return reason;
      }
      i++;
      continue;
    }
  }
  return null;
}

function attachedSensitiveOptionValue(
  commandHead: string,
  token: string,
  optionsWithValue: ReadonlySet<string>,
): { option: string; value: string } | null {
  for (const option of SENSITIVE_OPTION_VALUE_OPTIONS[commandHead] ?? []) {
    const value = attachedShortOptionValue(token, option, optionsWithValue);
    if (value) return { option, value };
  }
  return null;
}

function normalizeSensitivePathCandidate(value: string): string {
  return value
    .replace(/^["']|["']$/g, "")
    .replace(/^!+/, "")
    .replace(/[{}[\]*?]/g, "");
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
    reason.startsWith("sensitive path read blocked") ||
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
