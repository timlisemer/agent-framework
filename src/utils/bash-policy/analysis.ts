import {
  analyzeXargsCommand,
  commandBare,
  hasValidShellLexing,
  optionConsumesSeparateValue,
  serializeShellCommandTokens,
  splitShellSegments,
  stripQuotedRegions,
  tokenizeShellSegment,
  walkShellCharacters,
  xargsCommandTokens,
} from "../shell-command-parser.js";
import type { ShellCharEvent } from "../shell-command-parser.js";
import type { XargsCommandAnalysis } from "../shell-command-parser.js";
import type {
  BashAnalysis,
  BashInvocation,
  BashInvocationSource,
  BashSegmentAnalysis,
} from "./types.js";

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

export function xargsPayloadAnalysis(invocation: BashInvocation): XargsCommandAnalysis | null {
  if (invocation.executable !== "xargs") return null;
  return analyzeXargsCommand(invocation.tokens);
}

export interface BashInvocationTraversalOptions {
  shouldTraverseCommand?(input: {
    command: string;
    source: BashInvocationSource;
    segments: readonly BashSegmentAnalysis[];
  }): boolean;
  shouldTraversePayload?(input: {
    parent: BashInvocation;
    source: Exclude<BashInvocationSource, "direct">;
    command: string;
    xargs?: XargsCommandAnalysis;
  }): boolean;
}

interface BashTraversalVisitor {
  visitCommand?(input: {
    command: string;
    source: BashInvocationSource;
    segments: readonly BashSegmentAnalysis[];
  }): boolean;
  visitInvocation?(invocation: BashInvocation): boolean;
}

type NestedInvocationPayload =
  | {
    source: "shell-payload" | "eval-payload";
    command: string;
  }
  | {
    source: "xargs-payload";
    command: string;
    tokens: string[];
    xargs: XargsCommandAnalysis;
  };

function directSegments(command: string, source: BashInvocationSource): BashSegmentAnalysis[] {
  const split = splitShellSegments(command);
  return split.segments.map((segment, index) => {
    const tokens = tokenizeShellSegment(segment.trim());
    const operator = split.operators[index] ?? null;
    return {
      segment,
      tokens,
      operator,
      backgrounded: operator === "&",
      invocation: wrappedExecutableInvocation(tokens, segment.trim(), source),
    };
  });
}

function tokenPayloadSegments(
  tokens: string[],
  source: BashInvocationSource,
): BashSegmentAnalysis[] {
  const command = serializeShellCommandTokens(tokens);
  return [{
    segment: command,
    tokens,
    operator: null,
    backgrounded: false,
    invocation: wrappedExecutableInvocation(tokens, command, source),
  }];
}

function nestedInvocationPayloads(invocation: BashInvocation): NestedInvocationPayload[] {
  const payloads: NestedInvocationPayload[] = [];
  const shellPayload = shellPayloadCommand(invocation);
  if (shellPayload) {
    payloads.push({ source: "shell-payload", command: shellPayload });
  }
  const evalPayload = evalPayloadCommand(invocation);
  if (evalPayload) {
    payloads.push({ source: "eval-payload", command: evalPayload });
  }
  const xargs = xargsPayloadAnalysis(invocation);
  if (xargs?.payloadTokens && xargs.payloadTokens.length > 0) {
    payloads.push({
      source: "xargs-payload",
      command: serializeShellCommandTokens(xargs.payloadTokens),
      tokens: xargs.payloadTokens,
      xargs,
    });
  }
  return payloads;
}

function walkBashPayload(
  command: string,
  source: BashInvocationSource,
  seen: Set<string>,
  options: BashInvocationTraversalOptions,
  visitor: BashTraversalVisitor,
  tokenPayload?: string[],
): boolean {
  const seenKey = tokenPayload
    ? `${source}:tokens:${JSON.stringify(tokenPayload)}`
    : `${source}:command:${command}`;
  if (seen.has(seenKey)) return false;
  seen.add(seenKey);
  const segments = tokenPayload
    ? tokenPayloadSegments(tokenPayload, source)
    : directSegments(command, source);
  if (options.shouldTraverseCommand?.({ command, source, segments }) === false) return false;
  if (visitor.visitCommand?.({ command, source, segments })) return true;

  for (const segment of segments) {
    const invocation = segment.invocation;
    if (!invocation) continue;
    if (visitor.visitInvocation?.(invocation)) return true;

    for (const payload of nestedInvocationPayloads(invocation)) {
      if (options.shouldTraversePayload?.({
        parent: invocation,
        source: payload.source,
        command: payload.command,
        xargs: "xargs" in payload ? payload.xargs : undefined,
      }) === false) continue;
      if (walkBashPayload(
        payload.command,
        payload.source,
        seen,
        options,
        visitor,
        "tokens" in payload ? payload.tokens : undefined,
      )) return true;
    }
  }

  return false;
}

export function collectBashInvocations(
  command: string,
  options: BashInvocationTraversalOptions = {},
): BashInvocation[] {
  const invocations: BashInvocation[] = [];
  walkBashPayload(command, "direct", new Set(), options, {
    visitInvocation: (invocation) => {
      invocations.push(invocation);
      return false;
    },
  });
  return invocations;
}

export function analyzeBashCommand(command: string): BashAnalysis {
  const trimmed = command.trim();
  const split = splitShellSegments(trimmed);
  const segments = directSegments(trimmed, "direct");

  return {
    command,
    trimmed,
    segments,
    backgrounded: split.backgrounded,
    hasComplexOperator: split.hasComplexOperator,
    invocations: collectBashInvocations(trimmed),
  };
}

export function nestedPayloadCommands(analysis: BashAnalysis): string[] {
  const payloads: string[] = [];
  walkBashPayload(analysis.trimmed, "direct", new Set(), {}, {
    visitCommand: ({ command, source }) => {
      if (source !== "direct") payloads.push(command);
      return false;
    },
  });
  return payloads;
}

export function firstCommandHead(command: string): string | undefined {
  const firstSegment = splitShellSegments(command).segments.find((s) => s.trim());
  if (!firstSegment) return undefined;
  const token = tokenizeShellSegment(firstSegment)[0];
  return token ? commandBare(token) : undefined;
}

export function commandSegmentsContainCommandPredicate(
  command: string,
  commandName: string,
  predicate: (tokens: string[]) => boolean,
): boolean {
  return collectBashInvocations(command).some((invocation) =>
    invocation.executable === commandName && predicate(invocation.tokens)
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
  return walkBashPayload(command, "direct", new Set(), {}, {
    visitCommand: ({ command: candidateCommand }) => predicate(candidateCommand),
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

function commandHasActiveShellExpansion(command: string): boolean {
  return scanShellActiveChars(command, ({ ch, quote }) =>
    (ch === "$" && quote !== "'") ||
    quote === null && (ch === "*" || ch === "?" || ch === "[" || ch === "{" || ch === "~")
  );
}

export function hasActiveShellExpansion(command: string): boolean {
  return commandOrNestedPayloadMatches(command, commandHasActiveShellExpansion);
}

function commandHasActiveShellGrouping(command: string): boolean {
  return scanShellActiveChars(command, ({ ch, quote }) =>
    quote === null && (ch === "(" || ch === ")")
  );
}

export function hasActiveShellGrouping(command: string): boolean {
  return commandOrNestedPayloadMatches(command, commandHasActiveShellGrouping);
}

interface ActiveOutputRedirect {
  operator: ">" | ">>" | ">|";
  target: string;
  targetResolved: boolean;
}

const SAFE_DEVICE_REDIRECT_TARGETS: ReadonlySet<string> = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/fd/1",
  "/dev/fd/2",
]);

function shellWordAt(command: string, start: number): {
  target: string;
  resolved: boolean;
} {
  const remainder = command.slice(start);
  const targetSegment = splitShellSegments(remainder).segments[0] ?? "";
  const target = tokenizeShellSegment(targetSegment)[0] ?? "";
  return {
    target,
    resolved: target.length > 0 && hasValidShellLexing(targetSegment),
  };
}

function activeOutputRedirects(command: string): ActiveOutputRedirect[] {
  const redirects: ActiveOutputRedirect[] = [];
  scanShellActiveChars(command, ({ ch, next, prev, index, quote }) => {
    if (
      quote !== null ||
      ch !== ">" ||
      prev === ">" ||
      next === "(" ||
      next === "&"
    ) return false;

    const operator: ActiveOutputRedirect["operator"] = next === ">"
      ? ">>"
      : next === "|"
        ? ">|"
        : ">";
    let targetStart = index + operator.length;
    while (targetStart < command.length && /\s/.test(command[targetStart])) targetStart++;
    if (command[targetStart] === "&") return false;
    const parsedTarget = shellWordAt(command, targetStart);
    redirects.push({
      operator,
      target: parsedTarget.target,
      targetResolved: parsedTarget.resolved,
    });
    return false;
  });
  return redirects;
}

function commandHasActiveFileRedirect(command: string): boolean {
  return activeOutputRedirects(command).some((redirect) =>
    !redirect.targetResolved || !SAFE_DEVICE_REDIRECT_TARGETS.has(redirect.target)
  );
}

export function hasActiveFileRedirect(command: string): boolean {
  return commandOrNestedPayloadMatches(command, commandHasActiveFileRedirect);
}

function commandHasActiveRedirect(
  command: string,
  operator: "<" | ">",
): boolean {
  return scanShellActiveChars(command, ({ ch, next, quote }) =>
    quote === null && ch === operator && next !== "("
  );
}

function hasActiveRedirect(
  command: string,
  operator: "<" | ">",
): boolean {
  return commandOrNestedPayloadMatches(command, (candidateCommand) =>
    commandHasActiveRedirect(candidateCommand, operator)
  );
}

export function hasActiveOutputRedirect(command: string): boolean {
  return hasActiveRedirect(command, ">");
}

export function hasActiveInputRedirect(command: string): boolean {
  return hasActiveRedirect(command, "<");
}
