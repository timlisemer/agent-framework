export type ShellQuote = "'" | "\"";

export interface ShellCharEvent {
  ch: string;
  next?: string;
  prev?: string;
  index: number;
  quote: ShellQuote | null;
  quoted: boolean;
  quoteBoundary: boolean;
  escapeInitiator: boolean;
  escaped: boolean;
  active: boolean;
}

interface ShellCharacterWalkResult {
  escaped: boolean;
  quote: ShellQuote | null;
  stopped: boolean;
}

export function stripShellGrouping(token: string): string {
  return token.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

export function commandBare(token: string): string {
  const cleaned = stripShellGrouping(token);
  return cleaned.startsWith("/") ? cleaned.split("/").pop()! : cleaned;
}

export function quoteShellToken(
  token: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return `"${token.replace(/"/g, '""')}"`;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

export function serializeShellCommandTokens(
  tokens: readonly string[],
): string {
  return tokens.map((token) =>
    /^[A-Za-z0-9_@%+=:,./-]+$/.test(token) ? token : quoteShellToken(token, "linux")
  ).join(" ");
}

export function optionConsumesSeparateValue(token: string, optionsWithValue: ReadonlySet<string>): boolean {
  const eqIndex = token.indexOf("=");
  if (eqIndex > 0 && optionsWithValue.has(token.slice(0, eqIndex))) return false;
  if (optionsWithValue.has(token)) return true;

  for (const option of optionsWithValue) {
    if (/^-[A-Za-z]$/.test(option) && token.startsWith(option) && token.length > option.length) {
      return false;
    }
  }
  return false;
}

export function inlineLongOptionValue(token: string): { option: string; value: string } | null {
  if (!token.startsWith("--")) return null;
  const separator = token.indexOf("=");
  if (separator <= 0) return null;
  return {
    option: token.slice(0, separator),
    value: token.slice(separator + 1),
  };
}

export function canonicalOptionName(token: string): string {
  const separator = token.indexOf("=");
  if (separator > 0) return token.slice(0, separator);
  return token;
}

export function attachedShortOptionValue(
  token: string,
  option: string,
  optionsWithValue?: ReadonlySet<string>,
): string | null {
  if (optionsWithValue && !optionsWithValue.has(option)) return null;
  if (!/^-[A-Za-z]$/.test(option)) return null;
  if (!token.startsWith(option) || token.length <= option.length || token.startsWith("--")) return null;
  return token.slice(option.length);
}

export function tokenHasOption(token: string, options: ReadonlySet<string>): boolean {
  if (options.has(token)) return true;
  const inline = inlineLongOptionValue(token);
  if (inline && options.has(inline.option)) return true;
  if (/^-[A-Za-z]\S*/.test(token)) {
    for (const flag of token.slice(1)) {
      if (options.has(`-${flag}`)) return true;
    }
  }
  return false;
}

export interface ShellOptionArgumentPolicy {
  optionsWithOneValue?: ReadonlySet<string>;
  optionsWithTwoValues?: ReadonlySet<string>;
  trackedOptions?: ReadonlySet<string>;
  knownOptions?: ReadonlySet<string>;
}

export interface ParsedShellOptionArguments {
  positionals: string[];
  encounteredOptions: ReadonlySet<string>;
  incompleteOptions: readonly string[];
  optionValues: ReadonlyMap<string, readonly string[]>;
  unrecognizedOptions: readonly string[];
}

interface ParsedValuedOption {
  option: string;
  valueCount: number;
  attachedValues: string[];
}

export function parseShellOptionArguments(
  args: readonly string[],
  policy: ShellOptionArgumentPolicy,
): string[] {
  return parseShellOptionArgumentsDetailed(args, policy).positionals;
}

export function parseShellOptionArgumentsDetailed(
  args: readonly string[],
  policy: ShellOptionArgumentPolicy,
): ParsedShellOptionArguments {
  const positionals: string[] = [];
  const encounteredOptions = new Set<string>();
  const incompleteOptions: string[] = [];
  const optionValues = new Map<string, string[]>();
  const unrecognizedOptions: string[] = [];
  let parsingOptions = true;

  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token.startsWith("-") && token !== "-") {
      const parsedOption = parseShellOptionToken(token, policy);
      for (const option of parsedOption.options) {
        if (policy.trackedOptions?.has(option)) encounteredOptions.add(option);
      }
      unrecognizedOptions.push(...parsedOption.unrecognizedOptions);
      if (parsedOption.valuedOption) {
        const { values, consumedFollowingValues, complete } = consumeShellOptionValues(
          args,
          i,
          parsedOption.valuedOption,
        );
        const { option } = parsedOption.valuedOption;
        optionValues.set(option, [...(optionValues.get(option) ?? []), ...values]);
        if (!complete) incompleteOptions.push(option);
        i += consumedFollowingValues;
      }
      continue;
    }
    positionals.push(token);
  }

  return {
    positionals,
    encounteredOptions,
    incompleteOptions,
    optionValues,
    unrecognizedOptions,
  };
}

function parseShellOptionToken(
  token: string,
  policy: ShellOptionArgumentPolicy,
): {
  options: string[];
  unrecognizedOptions: string[];
  valuedOption: ParsedValuedOption | null;
} {
  const options: string[] = [];
  const unrecognizedOptions: string[] = [];
  const inline = inlineLongOptionValue(token);
  const canonical = canonicalOptionName(token);
  if (token.startsWith("--")) {
    options.push(canonical);
    if (policy.knownOptions && !policy.knownOptions.has(canonical)) {
      unrecognizedOptions.push(canonical);
    }
    const valueCount = shellOptionValueCount(canonical, policy);
    if (inline && valueCount === 0 && policy.knownOptions?.has(canonical)) {
      unrecognizedOptions.push(token);
    }
    return {
      options,
      unrecognizedOptions,
      valuedOption: valueCount === 0
        ? null
        : { option: canonical, valueCount, attachedValues: inline ? [inline.value] : [] },
    };
  }

  const cluster = token.slice(1);
  for (let index = 0; index < cluster.length; index++) {
    const option = `-${cluster[index]}`;
    options.push(option);
    if (policy.knownOptions && !policy.knownOptions.has(option)) {
      unrecognizedOptions.push(option);
    }
    const valueCount = shellOptionValueCount(option, policy);
    if (valueCount === 0) continue;
    return {
      options,
      unrecognizedOptions,
      valuedOption: {
        option,
        valueCount,
        attachedValues: index < cluster.length - 1 ? [cluster.slice(index + 1)] : [],
      },
    };
  }
  return { options, unrecognizedOptions, valuedOption: null };
}

function consumeShellOptionValues(
  args: readonly string[],
  optionIndex: number,
  valuedOption: ParsedValuedOption,
): {
  values: string[];
  consumedFollowingValues: number;
  complete: boolean;
} {
  const values = [...valuedOption.attachedValues];
  const consumedFollowingValues = Math.max(
    0,
    valuedOption.valueCount - valuedOption.attachedValues.length,
  );
  for (
    let offset = 1;
    offset <= consumedFollowingValues && optionIndex + offset < args.length;
    offset++
  ) {
    values.push(args[optionIndex + offset]);
  }
  return {
    values,
    consumedFollowingValues,
    complete: values.length === valuedOption.valueCount,
  };
}

function shellOptionValueCount(
  option: string,
  policy: ShellOptionArgumentPolicy,
): number {
  if (policy.optionsWithTwoValues?.has(option)) return 2;
  if (policy.optionsWithOneValue?.has(option)) return 1;
  return 0;
}

export function hasShellOption(tokens: readonly string[], options: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (token === "--") return false;
    if (tokenHasOption(token, options)) return true;
  }
  return false;
}

export const XARGS_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-a", "--arg-file",
  "-d", "--delimiter",
  "-E", "--eof",
  "-I", "--replace",
  "-L", "--max-lines",
  "-n", "--max-args",
  "-P", "--max-procs",
  "-s", "--max-chars",
  "--process-slot-var",
]);

const XARGS_OPTIONS_WITHOUT_VALUE: ReadonlySet<string> = new Set([
  "-0", "--null",
  "-o", "--open-tty",
  "-p", "--interactive",
  "-r", "--no-run-if-empty",
  "-t", "--verbose",
  "-x", "--exit",
  "--show-limits",
  "--help",
  "--version",
]);

const XARGS_KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  ...XARGS_OPTIONS_WITH_VALUE,
  ...XARGS_OPTIONS_WITHOUT_VALUE,
]);

function parseXargsPrefix(tokens: readonly string[]): {
  payloadStart: number | null;
  optionValues: ReadonlyMap<string, readonly string[]>;
  valid: boolean;
} {
  const optionValues = new Map<string, string[]>();
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      return {
        payloadStart: i + 1 < tokens.length ? i + 1 : null,
        optionValues,
        valid: true,
      };
    }
    if (!token.startsWith("-") || token === "-") {
      return { payloadStart: i, optionValues, valid: true };
    }

    const parsed = parseShellOptionToken(token, {
      optionsWithOneValue: XARGS_OPTIONS_WITH_VALUE,
      knownOptions: XARGS_KNOWN_OPTIONS,
    });
    if (parsed.unrecognizedOptions.length > 0) {
      return { payloadStart: null, optionValues, valid: false };
    }
    if (parsed.valuedOption) {
      const { values, consumedFollowingValues, complete } = consumeShellOptionValues(
        tokens,
        i,
        parsed.valuedOption,
      );
      const { option } = parsed.valuedOption;
      optionValues.set(option, [...(optionValues.get(option) ?? []), ...values]);
      if (!complete || values.some((value) => !validXargsOptionValue(option, value))) {
        return { payloadStart: null, optionValues, valid: false };
      }
      i += consumedFollowingValues;
    }
  }
  return { payloadStart: null, optionValues, valid: true };
}

function validXargsOptionValue(option: string, value: string): boolean {
  if (option === "-n" || option === "--max-args" ||
      option === "-L" || option === "--max-lines" ||
      option === "-s" || option === "--max-chars") {
    return /^[1-9]\d*$/.test(value);
  }
  if (option === "-P" || option === "--max-procs") {
    return /^\d+$/.test(value);
  }
  if (option === "--process-slot-var") {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
  }
  if (option === "-d" || option === "--delimiter") {
    return [...value].length === 1 || /^\\(?:[0-7]{1,3}|x[0-9A-Fa-f]{2}|.)$/.test(value);
  }
  if (option === "-I" || option === "--replace") {
    return value.length > 0;
  }
  return value.length > 0 || option === "-E" || option === "--eof";
}

export interface XargsCommandAnalysis {
  payloadTokens: string[] | null;
  optionValues: ReadonlyMap<string, readonly string[]>;
  valid: boolean;
}

export function analyzeXargsCommand(tokens: readonly string[]): XargsCommandAnalysis {
  const { payloadStart, optionValues, valid } = parseXargsPrefix(tokens);
  return {
    payloadTokens: payloadStart === null ? null : tokens.slice(payloadStart),
    optionValues,
    valid,
  };
}

export function xargsPrefixIsValid(tokens: readonly string[]): boolean {
  return analyzeXargsCommand(tokens).valid;
}

export function xargsCommandTokens(tokens: string[]): string[] | null {
  return analyzeXargsCommand(tokens).payloadTokens;
}

function walkShellCharactersDetailed(
  input: string,
  visit: (event: ShellCharEvent) => boolean | void,
): ShellCharacterWalkResult {
  let quote: ShellQuote | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const eventBase = {
      ch,
      next: input[i + 1],
      prev: input[i - 1],
      index: i,
    };

    if (quote === "'") {
      const quoteBoundary = ch === "'";
      if (visit({
        ...eventBase,
        quote,
        quoted: true,
        quoteBoundary,
        escapeInitiator: false,
        escaped: false,
        active: false,
      })) return { escaped, quote, stopped: true };
      if (quoteBoundary) quote = null;
      continue;
    }

    if (escaped) {
      if (ch === "\n") {
        escaped = false;
        continue;
      }
      if (visit({
        ...eventBase,
        quote,
        quoted: quote !== null,
        quoteBoundary: false,
        escapeInitiator: false,
        escaped: true,
        active: false,
      })) return { escaped, quote, stopped: true };
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      const doubleQuoteEscapable = eventBase.next === "$" ||
        eventBase.next === "`" ||
        eventBase.next === '"' ||
        eventBase.next === "\\" ||
        eventBase.next === "\n";
      if (quote === '"' && !doubleQuoteEscapable) {
        if (visit({
          ...eventBase,
          quote,
          quoted: true,
          quoteBoundary: false,
          escapeInitiator: false,
          escaped: false,
          active: true,
        })) return { escaped, quote, stopped: true };
        continue;
      }
      if (visit({
        ...eventBase,
        quote,
        quoted: quote !== null,
        quoteBoundary: false,
        escapeInitiator: true,
        escaped: false,
        active: false,
      })) return { escaped, quote, stopped: true };
      escaped = true;
      continue;
    }

    if (ch === "'" && quote === null) {
      quote = "'";
      if (visit({
        ...eventBase,
        quote,
        quoted: true,
        quoteBoundary: true,
        escapeInitiator: false,
        escaped: false,
        active: false,
      })) return { escaped, quote, stopped: true };
      continue;
    }

    if (ch === "\"") {
      const nextQuote: ShellQuote | null = quote === "\"" ? null : (quote === null ? "\"" : quote);
      if (visit({
        ...eventBase,
        quote: quote === null ? "\"" : quote,
        quoted: true,
        quoteBoundary: true,
        escapeInitiator: false,
        escaped: false,
        active: false,
      })) return { escaped, quote, stopped: true };
      quote = nextQuote;
      continue;
    }

    if (visit({
      ...eventBase,
      quote,
      quoted: quote !== null,
      quoteBoundary: false,
      escapeInitiator: false,
      escaped: false,
      active: true,
    })) return { escaped, quote, stopped: true };
  }

  return { escaped, quote, stopped: false };
}

export function walkShellCharacters(
  input: string,
  visit: (event: ShellCharEvent) => boolean | void,
): boolean {
  return walkShellCharactersDetailed(input, visit).stopped;
}

/** True only when quotes are balanced and no escape is left dangling at EOF. */
export function hasValidShellLexing(input: string): boolean {
  const result = walkShellCharactersDetailed(input, () => false);
  return result.quote === null && !result.escaped;
}

export function stripQuotedRegions(s: string): string {
  let out = "";
  walkShellCharacters(s, (event) => {
    out += event.quoted ? " " : event.ch;
  });
  return out;
}

export function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let tokenStarted = false;

  walkShellCharacters(segment.trim(), (event) => {
    if (event.quoteBoundary || event.escapeInitiator) {
      tokenStarted = true;
      return;
    }

    if (!event.quoted && !event.escaped && /\s/.test(event.ch)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      return;
    }

    current += event.ch;
    tokenStarted = true;
  });

  if (tokenStarted) tokens.push(current);
  return tokens;
}

export function splitShellSegments(command: string): {
  segments: string[];
  operators: Array<string | null>;
  hasComplexOperator: boolean;
  backgrounded: boolean;
} {
  const basis = stripQuotedRegions(command);
  const splitRegex = /\s*(?:\|\||&&|[;|\n\r]|(?<![<>])&)\s*/g;
  const segments: string[] = [];
  const operators: Array<string | null> = [];
  let last = 0;
  let hasComplexOperator = false;
  let backgrounded = false;
  for (const m of basis.matchAll(splitRegex)) {
    const operatorText = m[0];
    const operatorMatch = operatorText.match(/\|\||&&|[;|\n\r]|(?<![<>])&/);
    if (!operatorMatch || operatorMatch.index === undefined) continue;
    const operatorStart = (m.index ?? 0) + operatorMatch.index;
    const operatorEnd = operatorStart + operatorMatch[0].length;
    hasComplexOperator = true;
    if (operatorMatch[0].includes("&") && operatorMatch[0] !== "&&") {
      backgrounded = true;
    }
    segments.push(command.slice(last, operatorStart));
    operators.push(operatorMatch[0]);
    last = operatorEnd;
  }
  segments.push(command.slice(last));
  operators.push(null);
  return { segments, operators, hasComplexOperator, backgrounded };
}
