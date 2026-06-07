import {
  commandBare,
  optionConsumesSeparateValue,
  splitShellSegments,
  stripShellGrouping,
  tokenizeShellSegment,
  xargsCommandTokens,
} from "./shell-command-parser.js";

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

const WRAPPER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-a", "-C", "-f", "-g", "-h", "-o", "-u",
  "--chdir", "--group", "--host", "--output", "--user",
]);
const NICE_WRAPPER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-n", "--adjustment"]);
const SUDO_WRAPPER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-g", "-h", "-p", "-u",
  "--group", "--host", "--prompt", "--user",
]);
const TIMEOUT_WRAPPER_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-k", "--kill-after"]);

function skipWrapperOptions(
  tokens: string[],
  start: number,
  valueOptions: ReadonlySet<string> = WRAPPER_OPTIONS_WITH_VALUE,
): number {
  let i = start;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const token = tokens[i];
    i++;
    if (optionConsumesSeparateValue(token, valueOptions) && i < tokens.length) {
      i++;
    }
  }
  return i;
}

function wrappedExecutableTokenIndex(tokens: string[]): number {
  let i = 0;
  while (i < tokens.length) {
    const token = commandBare(tokens[i]);
    if (token === "") {
      i++;
      continue;
    }
    if (token === "nice") {
      i = skipWrapperOptions(tokens, i + 1, NICE_WRAPPER_OPTIONS_WITH_VALUE);
      continue;
    }
    if (token === "sudo") {
      i = skipWrapperOptions(tokens, i + 1, SUDO_WRAPPER_OPTIONS_WITH_VALUE);
      continue;
    }
    if (token === "time" || token === "exec" || token === "nohup" || token === "stdbuf" || token === "parallel" || token === "watch") {
      i = skipWrapperOptions(tokens, i + 1);
      continue;
    }
    if (token === "timeout") {
      i = skipWrapperOptions(tokens, i + 1, TIMEOUT_WRAPPER_OPTIONS_WITH_VALUE);
      if (i < tokens.length && /^\d/.test(tokens[i])) {
        i++;
      }
      continue;
    }
    if (token === "setsid") {
      i = skipWrapperOptions(tokens, i + 1);
      continue;
    }
    if (token === "!" || token === "if" || token === "then" || token === "while" || token === "until" || token === "do") {
      i++;
      continue;
    }
    if (token === "command") {
      i++;
      while (i < tokens.length && tokens[i].startsWith("-")) {
        i++;
      }
      continue;
    }
    if (token === "env") {
      i = skipWrapperOptions(tokens, i + 1);
      while (i < tokens.length && tokens[i].includes("=")) {
        i++;
      }
      continue;
    }
    return i;
  }
  return -1;
}

function findDestructiveFlagsFromTokens(tokens: string[]): string[] {
  if (tokens.length === 0) return [];
  const bare = commandBare(tokens[0]);
  if (bare === "find") return findDestructiveFlagsFromFindArgs(tokens.slice(1));
  if (bare === "xargs") {
    const commandTokens = xargsCommandTokens(tokens);
    return commandTokens ? findDestructiveFlagsFromTokens(commandTokens) : [];
  }
  return [];
}

function findDestructiveFlagsFromSegment(segment: string): string[] {
  const tokens = tokenizeShellSegment(segment);
  if (tokens.length === 0) return [];

  const shellPayloadFlags = findDestructiveFlagsFromShellLauncher(tokens);
  if (shellPayloadFlags.length > 0) return shellPayloadFlags;

  const evalPayloadFlags = findDestructiveFlagsFromEval(tokens);
  if (evalPayloadFlags.length > 0) return evalPayloadFlags;

  const index = wrappedExecutableTokenIndex(tokens);
  return index >= 0 ? findDestructiveFlagsFromTokens(tokens.slice(index)) : [];
}

function findDestructiveFlagsFromShellLauncher(tokens: string[]): string[] {
  let start = wrappedExecutableTokenIndex(tokens);
  if (start < 0) return [];
  let head = commandBare(tokens[start]);
  if (head === "busybox" && start + 1 < tokens.length) {
    start++;
    head = commandBare(tokens[start]);
  }
  if (head !== "sh" && head !== "bash" && head !== "zsh" && head !== "dash") return [];

  for (let i = start + 1; i < tokens.length - 1; i++) {
    const option = tokens[i];
    if (option === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
      return findDestructiveFlagsFromCommand(tokens[i + 1]);
    }
  }
  return [];
}

function findDestructiveFlagsFromEval(tokens: string[]): string[] {
  const start = wrappedExecutableTokenIndex(tokens);
  if (start < 0 || commandBare(tokens[start]) !== "eval") return [];
  const command = tokens.slice(start + 1).join(" ");
  return command ? findDestructiveFlagsFromCommand(command) : [];
}

export function findDestructiveFlagsFromCommand(command: string): string[] {
  return splitShellSegments(command).segments.flatMap((segment) =>
    findDestructiveFlagsFromSegment(segment.trim())
  );
}
