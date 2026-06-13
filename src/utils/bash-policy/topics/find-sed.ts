import { optionConsumesSeparateValue, stripShellGrouping } from "../../shell-command-parser.js";
import {
  analyzeBashCommand,
  commandBare,
} from "../analysis.js";
import type { BashPolicyFinding } from "../types.js";

export const FIND_DESTRUCTIVE_FLAG_NAMES = [
  "delete",
  "exec",
  "execdir",
  "ok",
  "okdir",
  "fprint",
  "fprint0",
  "fprintf",
  "fls",
] as const;

const FIND_DESTRUCTIVE_FLAG_ALTERNATION = FIND_DESTRUCTIVE_FLAG_NAMES.join("|");

export const FIND_DESTRUCTIVE_FLAG_TOKEN_PATTERN = new RegExp(
  `^-(?:${FIND_DESTRUCTIVE_FLAG_ALTERNATION})$`,
);

export const FIND_DESTRUCTIVE_DENY_REASON = `find destructive flag (${
  FIND_DESTRUCTIVE_FLAG_NAMES.map((flag) => `-${flag}`).join("/")
})`;

export const FIND_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-type", "-user",
  "-group", "-perm", "-size", "-mtime", "-mmin", "-newer",
  "-printf",
]);

export const SED_IN_PLACE_DENY_REASON = "sed in-place edit (-i)";

const SED_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-e", "--expression", "-f", "--file",
]);

function findOptionConsumesSeparateValue(token: string): boolean {
  const normalized = stripShellGrouping(token);
  const eqIndex = normalized.indexOf("=");
  if (eqIndex > 0) return false;
  return FIND_OPTIONS_WITH_VALUE.has(normalized);
}

export function findDestructiveFlagsFromFindArgs(args: string[]): string[] {
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") break;
    const normalized = stripShellGrouping(token);
    if (FIND_DESTRUCTIVE_FLAG_TOKEN_PATTERN.test(normalized)) {
      flags.push(normalized.slice(1));
      continue;
    }
    if (findOptionConsumesSeparateValue(token)) {
      i++;
    }
  }
  return flags;
}

function findDestructiveFlagsFromTokens(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  const bare = commandBare(tokens[0]);
  if (bare === "find") return findDestructiveFlagsFromFindArgs(tokens.slice(1));
  return [];
}

export function findDestructiveFlagsFromCommand(command: string): string[] {
  return analyzeBashCommand(command).invocations.flatMap((invocation) =>
    findDestructiveFlagsFromTokens(invocation.tokens)
  );
}

export function tokensHaveFindDestructiveFlag(tokens: string[]): boolean {
  return findDestructiveFlagsFromFindArgs(tokens.slice(1)).length > 0;
}

export function tokensHaveSedInPlaceFlag(tokens: string[]): boolean {
  const args = tokens.slice(1);
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (token === "--") return false;
    if (token === "--in-place" || token.startsWith("--in-place=")) return true;
    if (token.startsWith("--expression=") || token.startsWith("--file=")) continue;
    if (optionConsumesSeparateValue(token, SED_OPTIONS_WITH_VALUE)) {
      i++;
      continue;
    }
    if (/^-[ef].+/.test(token)) continue;
    if (token.startsWith("--")) continue;
    if (token.startsWith("-") && token.slice(1).includes("i")) return true;
  }
  return false;
}

export function hasFindDestructiveFlag(command: string): boolean {
  return findDestructiveFlagsFromCommand(command).length > 0;
}

export function hasSedInPlaceFlag(command: string): boolean {
  return analyzeBashCommand(command).invocations.some((invocation) =>
    invocation.executable === "sed" && tokensHaveSedInPlaceFlag(invocation.tokens)
  );
}

export function findSedPolicyFindings(command: string): BashPolicyFinding[] {
  if (hasFindDestructiveFlag(command)) {
    return [{
      topic: "find-sed",
      role: "terminal-candidate",
      kind: "deny",
      name: "find destructive flag",
      reason: FIND_DESTRUCTIVE_DENY_REASON,
      alternative: FIND_DESTRUCTIVE_DENY_REASON,
    }];
  }
  if (hasSedInPlaceFlag(command)) {
    return [{
      topic: "find-sed",
      role: "terminal-candidate",
      kind: "deny",
      name: "sed in-place edit",
      reason: SED_IN_PLACE_DENY_REASON,
      alternative: SED_IN_PLACE_DENY_REASON,
    }];
  }
  return [];
}
