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

export function stripShellGrouping(token: string): string {
  return token.replace(/^[({]+/, "").replace(/[)}]+$/, "");
}

export function commandBare(token: string): string {
  const cleaned = stripShellGrouping(token);
  return cleaned.startsWith("/") ? cleaned.split("/").pop()! : cleaned;
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

export function hasShellOption(tokens: readonly string[], options: ReadonlySet<string>): boolean {
  for (const token of tokens) {
    if (token === "--") return false;
    if (tokenHasOption(token, options)) return true;
  }
  return false;
}

export function nonOptionTokens(tokens: readonly string[]): string[] {
  const marker = tokens.indexOf("--");
  if (marker >= 0) {
    return [
      ...tokens.slice(0, marker).filter((token) => !token.startsWith("-")),
      ...tokens.slice(marker + 1),
    ];
  }
  return tokens.filter((token) => !token.startsWith("-"));
}

export function stripOptionValueTokens(tokens: readonly string[], optionsWithValue: ReadonlySet<string>): string[] {
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

export const XARGS_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-a", "--arg-file",
  "-d", "--delimiter",
  "-E", "--eof",
  "-I", "--replace",
  "-n", "--max-args",
  "-P", "--max-procs",
  "-s", "--max-chars",
]);

export function xargsCommandTokens(tokens: string[]): string[] | null {
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === "--") {
      return i + 1 < tokens.length ? tokens.slice(i + 1) : null;
    }
    if (optionConsumesSeparateValue(token, XARGS_OPTIONS_WITH_VALUE)) {
      i++;
      continue;
    }
    if (token.startsWith("-")) continue;
    return tokens.slice(i);
  }
  return null;
}

export function walkShellCharacters(input: string, visit: (event: ShellCharEvent) => boolean | void): boolean {
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
      })) return true;
      if (quoteBoundary) quote = null;
      continue;
    }

    if (escaped) {
      if (visit({
        ...eventBase,
        quote,
        quoted: quote !== null,
        quoteBoundary: false,
        escapeInitiator: false,
        escaped: true,
        active: false,
      })) return true;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      if (visit({
        ...eventBase,
        quote,
        quoted: quote !== null,
        quoteBoundary: false,
        escapeInitiator: true,
        escaped: false,
        active: false,
      })) return true;
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
      })) return true;
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
      })) return true;
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
    })) return true;
  }

  return false;
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

  walkShellCharacters(segment.trim(), (event) => {
    if (event.quoteBoundary || event.escapeInitiator) return;

    if (!event.quoted && !event.escaped && /\s/.test(event.ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      return;
    }

    current += event.ch;
  });

  if (current) tokens.push(current);
  return tokens;
}

export function splitShellSegments(command: string): {
  segments: string[];
  hasComplexOperator: boolean;
  backgrounded: boolean;
} {
  const basis = stripQuotedRegions(command);
  const splitRegex = /\s*(?:\|\||&&|[;|\n\r]|(?<![<>])&)\s*/g;
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
