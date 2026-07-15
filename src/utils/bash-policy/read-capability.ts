import {
  collectBashInvocations,
  hasActiveCommandOrProcessSubstitution,
  hasActiveOutputRedirect,
  hasActiveInputRedirect,
  hasActiveShellGrouping,
  hasActiveShellExpansion,
} from "./analysis.js";
import type { BashInvocation } from "./types.js";
import { setsOverlap } from "./helpers.js";
import {
  hasValidShellLexing,
  parseShellOptionArgumentsDetailed,
} from "../shell-command-parser.js";
import type { CanonicalToolCapability } from "../tool-capabilities.js";

type CommandOperandPolicy = {
  optionsWithOneValue?: ReadonlySet<string>;
  disablesFileOperands?: ReadonlySet<string>;
  optionsWithoutValue?: ReadonlySet<string>;
  leadingProgramOperand?: boolean;
  validatesProgramOperand?: (program: string) => boolean;
  rejectsOptionValue?: (option: string, value: string) => boolean;
};

const READER_EARLY_EXIT_OPTIONS: ReadonlySet<string> = new Set([
  "--help",
  "--version",
]);
const EMPTY_OPTIONS: ReadonlySet<string> = new Set();

const HEAD_TAIL_COUNT_OPTIONS: ReadonlySet<string> = new Set([
  "-c", "--bytes",
  "-n", "--lines",
]);

const VALID_HEAD_TAIL_COUNT = /^[+-]?\d+(?:b|[kKMGTPEZYRQ](?:i?B)?)?$/;
const SAFE_SED_PRINT_PROGRAM = /^(?:p|\$p|[1-9]\d*(?:,(?:[1-9]\d*|\$))?p)$/;

function rejectsHeadTailCount(option: string, value: string): boolean {
  if (!HEAD_TAIL_COUNT_OPTIONS.has(option)) return false;
  return !VALID_HEAD_TAIL_COUNT.test(value) || /^[+-]?0+(?:[A-Za-z]+)?$/.test(value);
}

const FILE_CONTENT_OPERAND_POLICIES: Readonly<Record<string, CommandOperandPolicy>> = {
  cat: { disablesFileOperands: READER_EARLY_EXIT_OPTIONS },
  head: {
    optionsWithOneValue: HEAD_TAIL_COUNT_OPTIONS,
    disablesFileOperands: READER_EARLY_EXIT_OPTIONS,
    rejectsOptionValue: rejectsHeadTailCount,
  },
  sed: {
    disablesFileOperands: READER_EARLY_EXIT_OPTIONS,
    optionsWithoutValue: new Set(["-n", "--quiet", "--silent"]),
    leadingProgramOperand: true,
    validatesProgramOperand: (program) => SAFE_SED_PRINT_PROGRAM.test(program),
  },
  tail: {
    optionsWithOneValue: HEAD_TAIL_COUNT_OPTIONS,
    disablesFileOperands: READER_EARLY_EXIT_OPTIONS,
    rejectsOptionValue: rejectsHeadTailCount,
  },
};

export function bashReadFileOperands(command: string): string[] {
  return collectBashInvocations(command, {
    shouldTraverseCommand: ({ command: candidateCommand, source, segments }) =>
      source === "direct" &&
      hasValidShellLexing(candidateCommand) &&
      !hasActiveCommandOrProcessSubstitution(candidateCommand) &&
      !hasActiveOutputRedirect(candidateCommand) &&
      !hasActiveInputRedirect(candidateCommand) &&
      !hasActiveShellGrouping(candidateCommand) &&
      !hasActiveShellExpansion(candidateCommand) &&
      segments.length === 1 &&
      segments[0].operator === null &&
      !segments[0].backgrounded &&
      segments[0].invocation !== null,
    shouldTraversePayload: () => false,
  }).filter((invocation) =>
    invocation.source === "direct" && invocation.wrapperChain.length === 0
  ).flatMap(readFileOperandsForInvocation);
}

/**
 * Convert command-specific read proof into adapter-independent workflow
 * capabilities. Both established Read path spellings are included so the
 * generic matcher never needs a Bash-to-Read input exception.
 */
export function bashReadCapabilities(command: string): CanonicalToolCapability[] {
  return bashReadFileOperands(command).map((path) => ({
    tool: "Read",
    input: { file_path: path, path },
  }));
}

function readFileOperandsForInvocation(invocation: BashInvocation): string[] {
  const policy = FILE_CONTENT_OPERAND_POLICIES[invocation.executable];
  if (!policy) return [];

  const trackedOptions = new Set(policy.disablesFileOperands ?? []);
  const knownOptions = new Set([
    ...(policy.optionsWithOneValue ?? []),
    ...(policy.disablesFileOperands ?? []),
    ...(policy.optionsWithoutValue ?? []),
  ]);
  const {
    positionals,
    encounteredOptions,
    incompleteOptions,
    optionValues,
    unrecognizedOptions,
  } = parseShellOptionArgumentsDetailed(
    invocation.args,
    { ...policy, trackedOptions, knownOptions },
  );
  if (unrecognizedOptions.length > 0 || incompleteOptions.length > 0) return [];
  const fileOperandsDisabled = setsOverlap(
    encounteredOptions,
    policy.disablesFileOperands ?? EMPTY_OPTIONS,
  );
  if (fileOperandsDisabled) return [];
  const rejectedOptionValue = [...optionValues].some(([option, values]) =>
    values.some((value) => policy.rejectsOptionValue?.(option, value) === true)
  );
  if (rejectedOptionValue) return [];
  if (
    policy.leadingProgramOperand &&
    (!positionals[0] || policy.validatesProgramOperand?.(positionals[0]) === false)
  ) return [];
  const inputPositionals = policy.leadingProgramOperand ? positionals.slice(1) : positionals;
  const fileOperands = inputPositionals.filter((operand) =>
    operand !== "-" &&
    (invocation.executable !== "tail" || !/^\+\d/.test(operand))
  );
  return fileOperands.length === 1 ? fileOperands : [];
}
