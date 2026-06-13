import {
  commandBare,
  optionConsumesSeparateValue,
  splitShellSegments,
  stripQuotedRegions,
  tokenizeShellSegment,
  walkShellCharacters,
  xargsCommandTokens,
} from "../shell-command-parser.js";
import type { ShellCharEvent } from "../shell-command-parser.js";
import type { BashAnalysis, BashInvocation, BashInvocationSource } from "./types.js";

export { commandBare, splitShellSegments, stripQuotedRegions, tokenizeShellSegment, xargsCommandTokens };

export const tokenizeSegment = tokenizeShellSegment;

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

const SHELL_EXECUTABLES: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash"]);

export function skipWrapperOptions(
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

export function wrappedExecutableTokenIndex(tokens: string[]): number {
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

function wrapperChain(tokens: string[], executableIndex: number): string[] {
  const wrappers: string[] = [];
  let i = 0;
  while (i < executableIndex) {
    const token = commandBare(tokens[i]);
    if (token !== "" && token !== "!" && token !== "if" && token !== "then" && token !== "while" && token !== "until" && token !== "do") {
      wrappers.push(token);
    }
    i++;
  }
  return wrappers;
}

export function wrappedExecutableInvocation(
  tokens: string[],
  segment = tokens.join(" "),
  source: BashInvocationSource = "direct",
): BashInvocation | null {
  const start = wrappedExecutableTokenIndex(tokens);
  if (start < 0 || start >= tokens.length) return null;

  const rawExecutable = commandBare(tokens[start]);
  const wrappers = wrapperChain(tokens, start);
  if (rawExecutable === "busybox" && start + 1 < tokens.length && SHELL_EXECUTABLES.has(commandBare(tokens[start + 1]))) {
    const executable = commandBare(tokens[start + 1]);
    return {
      segment,
      tokens: tokens.slice(start + 1),
      executable,
      args: tokens.slice(start + 2),
      wrapperChain: [...wrappers, "busybox"],
      source,
    };
  }

  return {
    segment,
    tokens: tokens.slice(start),
    executable: rawExecutable,
    args: tokens.slice(start + 1),
    wrapperChain: wrappers,
    source,
  };
}

export function shellPayloadCommand(invocation: BashInvocation): string | null {
  if (!SHELL_EXECUTABLES.has(invocation.executable)) return null;
  for (let i = 0; i < invocation.args.length - 1; i++) {
    const option = invocation.args[i];
    if (option === "-c" || /^-[A-Za-z]*c[A-Za-z]*$/.test(option)) {
      return invocation.args[i + 1];
    }
  }
  return null;
}

export function evalPayloadCommand(invocation: BashInvocation): string | null {
  if (invocation.executable !== "eval") return null;
  const command = invocation.args.join(" ");
  return command ? command : null;
}

export function xargsPayloadTokens(invocation: BashInvocation): string[] | null {
  if (invocation.executable !== "xargs") return null;
  return xargsCommandTokens(invocation.tokens);
}

function collectInvocations(command: string, source: BashInvocationSource, seen: Set<string>): BashInvocation[] {
  const seenKey = `${source}:${command}`;
  if (seen.has(seenKey)) return [];
  seen.add(seenKey);
  const { segments } = splitShellSegments(command);
  const invocations: BashInvocation[] = [];

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const tokens = tokenizeShellSegment(trimmed);
    const invocation = wrappedExecutableInvocation(tokens, trimmed, source);
    if (!invocation) continue;
    invocations.push(invocation);

    const shellPayload = shellPayloadCommand(invocation);
    if (shellPayload) {
      invocations.push(...collectInvocations(shellPayload, "shell-payload", seen));
    }

    const evalPayload = evalPayloadCommand(invocation);
    if (evalPayload) {
      invocations.push(...collectInvocations(evalPayload, "eval-payload", seen));
    }

    const xargsTokens = xargsPayloadTokens(invocation);
    if (xargsTokens && xargsTokens.length > 0) {
      invocations.push(...collectInvocations(xargsTokens.join(" "), "xargs-payload", seen));
    }
  }

  return invocations;
}

export function analyzeBashCommand(command: string): BashAnalysis {
  const trimmed = command.trim();
  const split = splitShellSegments(trimmed);
  const segments = split.segments.map((segment) => {
    const tokens = tokenizeShellSegment(segment.trim());
    return {
      segment,
      tokens,
      invocation: wrappedExecutableInvocation(tokens, segment.trim(), "direct"),
    };
  });

  return {
    command,
    trimmed,
    segments,
    backgrounded: split.backgrounded,
    hasComplexOperator: split.hasComplexOperator,
    invocations: collectInvocations(trimmed, "direct", new Set()),
  };
}

export function nestedPayloadCommands(analysis: BashAnalysis): string[] {
  const payloads: string[] = [];
  for (const { invocation } of analysis.segments) {
    if (!invocation) continue;
    const shellPayload = shellPayloadCommand(invocation);
    if (shellPayload) payloads.push(shellPayload);
    const evalPayload = evalPayloadCommand(invocation);
    if (evalPayload) payloads.push(evalPayload);
    const xargsTokens = xargsPayloadTokens(invocation);
    if (xargsTokens) payloads.push(xargsTokens.join(" "));
  }
  return payloads;
}

export function firstCommandHead(command: string): string | undefined {
  const firstSegment = splitShellSegments(command).segments.find((s) => s.trim());
  if (!firstSegment) return undefined;
  const token = tokenizeShellSegment(firstSegment)[0];
  return token ? commandBare(token) : undefined;
}

export function segmentContainsShellLauncherOperation(tokens: string[], commandPredicate: (command: string) => boolean): boolean {
  const invocation = wrappedExecutableInvocation(tokens);
  if (!invocation) return false;
  const payload = shellPayloadCommand(invocation);
  return payload ? commandPredicate(payload) : false;
}

export function segmentContainsEvalOperation(tokens: string[], commandPredicate: (command: string) => boolean): boolean {
  const invocation = wrappedExecutableInvocation(tokens);
  if (!invocation) return false;
  const payload = evalPayloadCommand(invocation);
  return payload ? commandPredicate(payload) : false;
}

export function tokensContainCommandPredicate(
  tokens: string[],
  commandName: string,
  predicate: (tokens: string[]) => boolean,
): boolean {
  if (tokens.length === 0) return false;
  const bare = commandBare(tokens[0]);
  if (bare === commandName) return predicate(tokens);
  if (bare === "xargs") {
    const commandTokens = xargsCommandTokens(tokens);
    return commandTokens ? tokensContainCommandPredicate(commandTokens, commandName, predicate) : false;
  }
  return false;
}

export function segmentContainsCommandPredicate(
  segment: string,
  commandName: string,
  predicate: (tokens: string[]) => boolean,
): boolean {
  const tokens = tokenizeShellSegment(segment);
  if (tokens.length === 0) return false;

  const commandPredicate = (command: string): boolean =>
    commandSegmentsContainCommandPredicate(command, commandName, predicate);

  if (segmentContainsShellLauncherOperation(tokens, commandPredicate)) return true;
  if (segmentContainsEvalOperation(tokens, commandPredicate)) return true;

  const index = wrappedExecutableTokenIndex(tokens);
  return index >= 0 && tokensContainCommandPredicate(tokens.slice(index), commandName, predicate);
}

export function commandSegmentsContainCommandPredicate(
  command: string,
  commandName: string,
  predicate: (tokens: string[]) => boolean,
): boolean {
  return splitShellSegments(command).segments.some((segment) =>
    segmentContainsCommandPredicate(segment.trim(), commandName, predicate)
  );
}

function scanShellActiveChars(command: string, predicate: (state: ShellCharEvent) => boolean): boolean {
  return walkShellCharacters(command, (event) => event.active && predicate(event));
}

function scanShellSubstitutionChars(command: string, predicate: (state: ShellCharEvent) => boolean): boolean {
  return walkShellCharacters(command, (event) =>
    event.quote !== "'" &&
    !event.quoteBoundary &&
    !event.escapeInitiator &&
    !event.escaped &&
    predicate(event)
  );
}

export function commandOrNestedPayloadMatches(command: string, predicate: (command: string) => boolean): boolean {
  if (predicate(command)) return true;

  return splitShellSegments(command).segments.some((segment) => {
    const tokens = tokenizeShellSegment(segment.trim());
    if (tokens.length === 0) return false;
    return segmentContainsShellLauncherOperation(tokens, (payload) => commandOrNestedPayloadMatches(payload, predicate)) ||
      segmentContainsEvalOperation(tokens, (payload) => commandOrNestedPayloadMatches(payload, predicate)) ||
      commandBare(tokens[0]) === "xargs" && (() => {
        const xargsTokens = xargsCommandTokens(tokens);
        return xargsTokens ? commandOrNestedPayloadMatches(xargsTokens.join(" "), predicate) : false;
      })();
  });
}

function commandHasActiveCommandOrProcessSubstitution(command: string): boolean {
  return scanShellSubstitutionChars(command, ({ ch, next, index }) => {
    if (ch === "`" || (ch === "$" && next === "(" && command[index + 2] !== "(") || (ch === "<" && next === "(") || (ch === ">" && next === "(")) {
      return true;
    }
    return false;
  });
}

export function hasActiveCommandOrProcessSubstitution(command: string): boolean {
  return commandOrNestedPayloadMatches(command, commandHasActiveCommandOrProcessSubstitution);
}

function commandHasActiveFileRedirect(command: string): boolean {
  return scanShellActiveChars(command, ({ ch, next, index: i, quote }) => {
    if (quote !== null || ch !== ">") return false;
    if (next === "(" || next === "&") return false;

    let j = next === ">" || next === "|" ? i + 2 : i + 1;
    while (j < command.length && /\s/.test(command[j])) j++;
    if (command[j] === "'" || command[j] === "\"") j++;
    if (command.startsWith("/dev/", j)) return false;
    if (j < command.length && !/[|&(\s]/.test(command[j])) return true;
    return false;
  });
}

export function hasActiveFileRedirect(command: string): boolean {
  return commandOrNestedPayloadMatches(command, commandHasActiveFileRedirect);
}
