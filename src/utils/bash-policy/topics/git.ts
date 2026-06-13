import { optionConsumesSeparateValue } from "../../shell-command-parser.js";
import {
  commandBare,
  commandOrNestedPayloadMatches,
  splitShellSegments,
  tokenizeSegment,
  wrappedExecutableTokenIndex,
} from "../analysis.js";
import { contentCommandCandidate } from "../helpers.js";
import { READ_ONLY_BASH_COMMANDS } from "./read-only-commands.js";
import type { BashPolicyFinding } from "../types.js";

export const READ_ONLY_GIT_COMMANDS_DESCRIPTION =
  "status, log, diff, show, branch list, remote -v/get-url/show -n, tag list, stash list/show, submodule status/summary, worktree list, config reads, reflog show/list, ls-tree, cat-file";

const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "blame", "cat-file", "describe", "diff", "grep", "log", "ls-files",
  "ls-tree", "rev-list", "rev-parse", "shortlog", "show", "show-branch",
  "status",
]);

const WORKFLOW_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "commit", "push",
]);

const WRITE_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "am", "apply", "bisect", "checkout", "cherry-pick", "clean",
  "clone", "fetch", "gc", "merge", "mv", "pull", "rebase",
  "reset", "restore", "revert", "rm", "switch",
]);

const MIXED_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "branch", "config", "reflog", "remote", "stash", "submodule", "tag",
  "worktree",
]);

const GIT_BRANCH_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-c", "-C", "--copy",
  "-d", "-D", "--delete",
  "-m", "-M", "--move",
  "--create-reflog",
  "-t", "--track", "--no-track",
  "-u", "--set-upstream-to",
  "--edit-description",
  "--unset-upstream",
]);

const GIT_BRANCH_READ_FILTER_FLAGS: ReadonlySet<string> = new Set([
  "-a", "--all", "-r", "--remotes",
  "--contains", "--no-contains", "--merged", "--no-merged", "--points-at",
  "--format", "--sort", "--column", "--list",
]);

const GIT_TAG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "-a", "--annotate",
  "-d", "--delete",
  "-f", "--force",
  "-F", "--file",
  "-m", "--message",
  "-s", "--sign",
  "-u", "--local-user",
]);

const GIT_TAG_READ_FILTER_FLAGS: ReadonlySet<string> = new Set([
  "-l", "--list", "-n", "--contains", "--no-contains", "--merged",
  "--no-merged", "--points-at", "--format", "--sort", "--column",
  "--ignore-case",
]);

const GIT_CONFIG_WRITE_FLAGS: ReadonlySet<string> = new Set([
  "--add", "--edit", "-e", "--replace-all", "--set", "--unset",
  "--unset-all", "--remove-section", "--rename-section",
]);

const GIT_CONFIG_READ_FLAGS: ReadonlySet<string> = new Set([
  "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l",
  "--show-origin", "--show-scope", "--name-only", "--includes", "--null",
  "-z",
]);

const GIT_CONFIG_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "--blob", "--default", "--file", "--type", "-f",
]);

const GIT_CONFIG_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "get", "get-all", "get-regexp", "get-urlmatch", "list",
]);

const GIT_CONFIG_WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "add", "edit", "remove-section", "rename-section", "replace-all", "set",
  "unset", "unset-all",
]);

const GIT_REFLOG_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["show", "list"]);
const GIT_REMOTE_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["get-url", "show"]);
const GIT_REMOTE_SHOW_READ_FLAGS: ReadonlySet<string> = new Set(["-n"]);
const GIT_STASH_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["list", "show"]);
const GIT_SUBMODULE_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["status", "summary"]);
const GIT_WORKTREE_READ_SUBCOMMANDS: ReadonlySet<string> = new Set(["list"]);

function gitSubcommandInfo(tokens: string[]): { subcommand: string; index: number } | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "-C" || token === "-c") {
      i++;
      continue;
    }
    if (token === "--git-dir" || token === "--work-tree") {
      i++;
      continue;
    }
    if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) continue;
    if (token.startsWith("-")) continue;
    return { subcommand: commandBare(token), index: i };
  }
  return null;
}

function hasOption(tokens: string[], options: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (token === "--") return false;
    if (options.has(token)) return true;
    const eqIndex = token.indexOf("=");
    if (eqIndex > 0 && options.has(token.slice(0, eqIndex))) return true;
    if (/^-[A-Za-z]\S*/.test(token)) {
      for (const flag of token.slice(1)) {
        if (options.has(`-${flag}`)) return true;
      }
    }
  }
  return false;
}

function nonOptionArgs(tokens: string[]): string[] {
  const marker = tokens.indexOf("--");
  if (marker >= 0) {
    return [
      ...tokens.slice(0, marker).filter((token) => !token.startsWith("-")),
      ...tokens.slice(marker + 1),
    ];
  }
  return tokens.filter((token) => !token.startsWith("-"));
}

function stripOptionValues(tokens: string[], optionsWithValue: ReadonlySet<string>): string[] {
  const result: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      result.push(...tokens.slice(i));
      break;
    }
    result.push(token);
    if (optionConsumesSeparateValue(token, optionsWithValue) && i + 1 < tokens.length) {
      i++;
    }
  }
  return result;
}

function readOnlyGitWithReadFilters(
  args: string[],
  writeFlags: ReadonlySet<string>,
  readFilterFlags: ReadonlySet<string>,
): boolean {
  if (hasOption(args, writeFlags)) return false;
  const positional = nonOptionArgs(args);
  if (positional.length === 0) return true;
  return hasOption(args, readFilterFlags);
}

function readOnlyGitFirstArg(args: string[], allowed: ReadonlySet<string>, allowMissing = false): boolean {
  const subcommand = nonOptionArgs(args)[0];
  return subcommand === undefined ? allowMissing : allowed.has(subcommand);
}

function readOnlyGitBranch(args: string[]): boolean {
  return readOnlyGitWithReadFilters(args, GIT_BRANCH_WRITE_FLAGS, GIT_BRANCH_READ_FILTER_FLAGS);
}

function readOnlyGitConfig(args: string[]): boolean {
  if (hasOption(args, GIT_CONFIG_WRITE_FLAGS)) return false;
  const positional = nonOptionArgs(stripOptionValues(args, GIT_CONFIG_OPTIONS_WITH_VALUE));
  const subcommand = positional[0];
  if (!subcommand) return true;
  if (GIT_CONFIG_WRITE_SUBCOMMANDS.has(subcommand)) return false;
  if (GIT_CONFIG_READ_SUBCOMMANDS.has(subcommand)) return true;
  if (hasOption(args, GIT_CONFIG_READ_FLAGS)) return true;
  return positional.length === 1;
}

function readOnlyGitReflog(args: string[]): boolean {
  return readOnlyGitFirstArg(args, GIT_REFLOG_READ_SUBCOMMANDS, true);
}

function readOnlyGitRemote(args: string[]): boolean {
  const subcommand = nonOptionArgs(args)[0];
  if (!subcommand) return true;
  if (subcommand === "show") return hasOption(args, GIT_REMOTE_SHOW_READ_FLAGS);
  return GIT_REMOTE_READ_SUBCOMMANDS.has(subcommand);
}

function readOnlyGitStash(args: string[]): boolean {
  return readOnlyGitFirstArg(args, GIT_STASH_READ_SUBCOMMANDS);
}

function readOnlyGitSubmodule(args: string[]): boolean {
  return readOnlyGitFirstArg(args, GIT_SUBMODULE_READ_SUBCOMMANDS, true);
}

function readOnlyGitTag(args: string[]): boolean {
  return readOnlyGitWithReadFilters(args, GIT_TAG_WRITE_FLAGS, GIT_TAG_READ_FILTER_FLAGS);
}

function readOnlyGitWorktree(args: string[]): boolean {
  return readOnlyGitFirstArg(args, GIT_WORKTREE_READ_SUBCOMMANDS);
}

function readOnlyMixedGitSubcommand(subcommand: string, args: string[]): boolean {
  switch (subcommand) {
    case "branch":
      return readOnlyGitBranch(args);
    case "config":
      return readOnlyGitConfig(args);
    case "reflog":
      return readOnlyGitReflog(args);
    case "remote":
      return readOnlyGitRemote(args);
    case "stash":
      return readOnlyGitStash(args);
    case "submodule":
      return readOnlyGitSubmodule(args);
    case "tag":
      return readOnlyGitTag(args);
    case "worktree":
      return readOnlyGitWorktree(args);
    default:
      return false;
  }
}

export function classifyGitInvocation(tokens: string[]): { allowed: true } | { allowed: false; reason: string } {
  const info = gitSubcommandInfo(tokens);
  if (!info) {
    return { allowed: false, reason: "git command missing read-only subcommand" };
  }

  const subcommand = info.subcommand;
  if (READ_ONLY_GIT_SUBCOMMANDS.has(subcommand)) {
    return { allowed: true };
  }

  if (MIXED_GIT_SUBCOMMANDS.has(subcommand)) {
    const args = tokens.slice(info.index + 1);
    if (readOnlyMixedGitSubcommand(subcommand, args)) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: `git subcommand not in read-only allowlist: ${subcommand}` };
}

export const validateReadOnlyGitCommand = classifyGitInvocation;

function tokensAreGitWorkflowWriteOperation(tokens: string[]): boolean {
  const info = gitSubcommandInfo(tokens);
  if (!info) return false;
  return WORKFLOW_GIT_SUBCOMMANDS.has(info.subcommand);
}

function tokensAreGitWriteOperation(tokens: string[]): boolean {
  const info = gitSubcommandInfo(tokens);
  if (!info) return false;
  if (WORKFLOW_GIT_SUBCOMMANDS.has(info.subcommand)) return false;
  if (WRITE_GIT_SUBCOMMANDS.has(info.subcommand)) return true;
  if (!MIXED_GIT_SUBCOMMANDS.has(info.subcommand)) return false;

  return !readOnlyMixedGitSubcommand(info.subcommand, tokens.slice(info.index + 1));
}

function shouldFallbackScanGitOperation(tokens: string[]): boolean {
  const head = commandBare(tokens[0]);
  return !READ_ONLY_BASH_COMMANDS.has(head);
}

function gitExecutableTokenIndex(tokens: string[]): number {
  const index = wrappedExecutableTokenIndex(tokens);
  return index >= 0 && commandBare(tokens[index]) === "git" ? index : -1;
}

function segmentContainsGitOperation(segment: string, predicate: (tokens: string[]) => boolean, scanAnywhere: boolean): boolean {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return false;

  if (!scanAnywhere) {
    const index = gitExecutableTokenIndex(tokens);
    return (index >= 0 && predicate(tokens.slice(index))) ||
      shouldFallbackScanGitOperation(tokens) && segmentContainsGitOperation(segment, predicate, true);
  }

  for (let i = 0; i < tokens.length; i++) {
    if (commandBare(tokens[i]) === "git" && predicate(tokens.slice(i))) {
      return true;
    }
  }
  return false;
}

function commandContainsGitOperation(
  command: string,
  predicate: (tokens: string[]) => boolean,
  scanAnywhere = false,
): boolean {
  return commandOrNestedPayloadMatches(command, (candidateCommand) =>
    splitShellSegments(candidateCommand).segments.some((segment) =>
      segmentContainsGitOperation(segment.trim(), predicate, scanAnywhere)
    )
  );
}

export function containsGitWorkflowWrite(command: string): boolean {
  return commandOrInvocationContainsGitOperation(command, tokensAreGitWorkflowWriteOperation);
}

export function containsGitWrite(command: string): boolean {
  return commandOrInvocationContainsGitOperation(command, tokensAreGitWriteOperation) ||
    containsGitWorkflowWrite(command) && commandOrInvocationContainsGitOperation(command, tokensAreGitWriteOperation, true);
}

function commandOrInvocationContainsGitOperation(
  command: string,
  predicate: (tokens: string[]) => boolean,
  scanAnywhere = false,
): boolean {
  return commandContainsGitOperation(command, predicate, scanAnywhere);
}

function contentContainsGitOperation(content: string, predicate: (tokens: string[]) => boolean): boolean {
  const candidate = contentCommandCandidate(content);
  const afterRun = candidate.replace(/^.*?\brun\s+/i, "");
  const singleQuotesAsPunctuation = candidate.replace(/'/g, " ");
  const afterRunSingleQuotesAsPunctuation = afterRun.replace(/'/g, " ");
  return commandContainsGitOperation(candidate, predicate) ||
    commandContainsGitOperation(afterRun, predicate) ||
    commandContainsGitOperation(singleQuotesAsPunctuation, predicate) ||
    commandContainsGitOperation(afterRunSingleQuotesAsPunctuation, predicate) ||
    commandContainsGitOperation(candidate, predicate, true) ||
    commandContainsGitOperation(afterRun, predicate, true) ||
    commandContainsGitOperation(singleQuotesAsPunctuation, predicate, true) ||
    commandContainsGitOperation(afterRunSingleQuotesAsPunctuation, predicate, true);
}

export function contentContainsGitWorkflowWrite(content: string): boolean {
  return contentContainsGitOperation(content, tokensAreGitWorkflowWriteOperation);
}

export function contentContainsGitWrite(content: string): boolean {
  return contentContainsGitOperation(content, tokensAreGitWriteOperation);
}

export function gitPolicyFindings(command: string): BashPolicyFinding[] {
  const findings: BashPolicyFinding[] = [];
  if (containsGitWorkflowWrite(command)) {
    findings.push({
      topic: "git",
      role: "terminal-candidate",
      kind: "deny",
      name: "git write op (MCP)",
      category: "git-write",
      reason: "git write op (MCP)",
    });
  }
  if (containsGitWrite(command)) {
    findings.push({
      topic: "git",
      role: "terminal-candidate",
      kind: "deny",
      name: "git write op",
      category: "git-write",
      reason: "git write op",
      alternative: "Git write operation denied",
    });
  }
  return findings;
}
