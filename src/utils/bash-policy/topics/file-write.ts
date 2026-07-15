import {
  parseShellOptionArgumentsDetailed,
} from "../../shell-command-parser.js";
import {
  analyzeBashCommand,
  commandSegmentsContainCommandPredicate,
  hasActiveFileRedirect,
  splitShellSegments,
} from "../analysis.js";
import { matchPatternInCommandTarget, matchingPatternFindings, payloadAwarePatternMatcher, resolveAlternative, setsOverlap } from "../helpers.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";

export const SHELL_REDIRECT_DENY_REASON = "shell redirect to file";
const BACKGROUND_FILE_WRITE_REASON = "background shell file write";
export type FileWritePolicyFingerprint = "bash:file-write" | "bash:background-file-write";

export const FILE_WRITE_PATTERNS: BlacklistPattern[] = [
  { pattern: /\b(?:echo|printf)\b[^;|&\n\r]*\d?>>?\|?\s*(?![&(])\S/, name: "echo redirect", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\btee\s+(?:-[A-Za-z]+\s+)*\S+/, name: "tee file write", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\bdd\b/, commandMatcher: commandHasDdOutputFile, contentMatcher: commandHasDdOutputFile, name: "dd file write", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\binstall\b/, commandMatcher: commandHasInstallTarget, contentMatcher: commandHasInstallTarget, name: "install file write", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\bcp\b/, commandMatcher: commandHasCopyTarget, contentMatcher: commandHasCopyTarget, name: "cp file write", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\bmv\b/, commandMatcher: commandHasMoveTarget, contentMatcher: commandHasMoveTarget, name: "mv file write", alternative: "Use Write tool", topic: "file-write" },
];

const FILE_WRITE_FINGERPRINT_REASON_FALLBACKS = [
  SHELL_REDIRECT_DENY_REASON,
  BACKGROUND_FILE_WRITE_REASON,
  ...FILE_WRITE_PATTERNS.map((pattern) => pattern.name),
];

const INSTALL_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set(["-d", "--directory"]);
const TARGET_DIRECTORY_OPTIONS: ReadonlySet<string> = new Set(["-t", "--target-directory"]);
const COPY_MOVE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-S", "--suffix",
  "-t", "--target-directory",
]);
const INSTALL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-g", "--group",
  "-m", "--mode",
  "-o", "--owner",
  "-S", "--suffix",
  "-t", "--target-directory",
  "--strip-program",
]);

export function matchFileWritePattern(command: string, pattern: BlacklistPattern): boolean {
  return splitShellSegments(command).segments.some((segment) => matchPatternInCommandTarget(segment.trim(), pattern));
}

export function fileWritePolicyFindings(command: string): BashPolicyFinding[] {
  const findings: BashPolicyFinding[] = [];
  const analysis = analyzeBashCommand(command);
  const candidateCommands = fileWriteCandidateCommands(command, analysis);
  const commandHasActiveOrNestedFileRedirect = candidateCommandsHaveActiveOrNestedFileRedirect(candidateCommands);
  if (analysisHasBackgroundedFileWriteSignal(analysis)) {
    findings.push({
      topic: "file-write",
      role: "terminal-candidate",
      kind: "deny",
      name: BACKGROUND_FILE_WRITE_REASON,
      category: "background-file-write",
      reason: BACKGROUND_FILE_WRITE_REASON,
      alternative: "Use Write tool",
    });
  }

  if (commandHasActiveOrNestedFileRedirect) {
    findings.push({
      topic: "file-write",
      role: "terminal-candidate",
      kind: "deny",
      name: "shell redirect",
      category: "file-write",
      reason: SHELL_REDIRECT_DENY_REASON,
      alternative: SHELL_REDIRECT_DENY_REASON,
    });
  }

  findings.push(...matchingPatternFindings(
    command,
    FILE_WRITE_PATTERNS,
    (_candidateCommand, pattern) => candidateCommands.some((candidate) =>
      payloadAwarePatternMatcher(candidate, pattern, matchFileWritePattern)
    ),
    (pattern) => ({
      topic: "file-write",
      name: pattern.name,
      category: "file-write",
      reason: pattern.name,
      alternative: resolveAlternative(pattern.alternative),
    }),
  ));
  return findings;
}

export function fileWritePolicyFingerprintCategories(
  command: string,
  reason: string,
): Set<FileWritePolicyFingerprint> {
  const fingerprints = new Set<FileWritePolicyFingerprint>();
  const findings = fileWritePolicyFindings(command);
  const hasBackgroundFileWrite =
    findings.some((finding) => finding.category === "background-file-write") ||
    reasonMatchesFileWriteFallback(reason, [BACKGROUND_FILE_WRITE_REASON]);
  const hasFileWrite =
    findings.length > 0 ||
    reasonMatchesFileWriteFallback(reason, FILE_WRITE_FINGERPRINT_REASON_FALLBACKS) ||
    /file write/i.test(reason);

  if (hasBackgroundFileWrite) fingerprints.add("bash:background-file-write");
  if (hasFileWrite) fingerprints.add("bash:file-write");
  return fingerprints;
}

function candidateCommandsHaveActiveOrNestedFileRedirect(candidateCommands: string[]): boolean {
  return candidateCommands.some((candidate) => hasActiveFileRedirect(candidate));
}

function candidateCommandsHavePatternFileWriteSignal(candidateCommands: string[]): boolean {
  return FILE_WRITE_PATTERNS.some((pattern) =>
    candidateCommands.some((candidate) => payloadAwarePatternMatcher(candidate, pattern, matchFileWritePattern))
  );
}

function candidateCommandsHaveFileWriteSignal(candidateCommands: string[]): boolean {
  return candidateCommandsHaveActiveOrNestedFileRedirect(candidateCommands) ||
    candidateCommandsHavePatternFileWriteSignal(candidateCommands);
}

function analysisHasBackgroundedFileWriteSignal(
  analysis: ReturnType<typeof analyzeBashCommand>,
): boolean {
  return analysis.segments.some(({ segment, backgrounded }) => {
    const trimmed = segment.trim();
    if (!backgrounded || !trimmed) return false;
    const segmentAnalysis = analyzeBashCommand(trimmed);
    return candidateCommandsHaveFileWriteSignal(fileWriteCandidateCommands(trimmed, segmentAnalysis));
  });
}

function reasonMatchesFileWriteFallback(reason: string, fallbackReasons: readonly string[]): boolean {
  const normalized = reason.toLowerCase();
  return fallbackReasons.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

function fileWriteCandidateCommands(
  command: string,
  analysis: ReturnType<typeof analyzeBashCommand>,
): string[] {
  return Array.from(new Set([
    command,
    ...analysis.invocations.map((invocation) => invocation.segment),
  ]));
}

function commandHasDdOutputFile(command: string): boolean {
  return commandSegmentsContainCommandPredicate(command, "dd", (tokens) =>
    tokens.slice(1).some((token) => /^of=.+/.test(token) && !token.startsWith("of=/dev/"))
  );
}

function commandHasInstallTarget(command: string): boolean {
  return commandSegmentsContainCommandPredicate(command, "install", (tokens) => {
    const parsed = parseCommandArguments(
      tokens,
      INSTALL_OPTIONS_WITH_VALUE,
      new Set([...INSTALL_DIRECTORY_OPTIONS, ...TARGET_DIRECTORY_OPTIONS]),
    );
    if (setsOverlap(parsed.encounteredOptions, INSTALL_DIRECTORY_OPTIONS)) {
      return parsed.positionals.length >= 1;
    }
    if (setsOverlap(parsed.encounteredOptions, TARGET_DIRECTORY_OPTIONS)) {
      return parsed.positionals.length >= 1;
    }
    return parsed.positionals.length >= 2;
  });
}

function parseCommandArguments(
  tokens: string[],
  optionsWithValue: ReadonlySet<string>,
  trackedOptions: ReadonlySet<string>,
): ReturnType<typeof parseShellOptionArgumentsDetailed> {
  return parseShellOptionArgumentsDetailed(tokens.slice(1), {
    optionsWithOneValue: optionsWithValue,
    trackedOptions,
  });
}

function commandHasCopyTarget(command: string): boolean {
  return commandHasCopyMoveTarget(command, "cp");
}

function commandHasMoveTarget(command: string): boolean {
  return commandHasCopyMoveTarget(command, "mv");
}

function commandHasCopyMoveTarget(command: string, commandName: string): boolean {
  return commandSegmentsContainCommandPredicate(command, commandName, (tokens) => {
    const parsed = parseCommandArguments(
      tokens,
      COPY_MOVE_OPTIONS_WITH_VALUE,
      TARGET_DIRECTORY_OPTIONS,
    );
    if (setsOverlap(parsed.encounteredOptions, TARGET_DIRECTORY_OPTIONS)) {
      return parsed.positionals.length >= 1;
    }
    return parsed.positionals.length >= 2;
  });
}
