import { redactPathTokens } from "../path-redaction.js";
import { commandOrNestedPayloadMatches, stripQuotedRegions } from "./analysis.js";
import type { BashPolicyFinding, BashPolicyTopic, BlacklistPattern } from "./types.js";

export function resolveAlternative(alt: string | (() => string)): string {
  return typeof alt === "function" ? alt() : alt;
}

export function policyTarget(command: string, redactPaths?: boolean): string {
  const quoteStrippedCommand = stripQuotedRegions(command);
  return redactPaths ? redactPathTokens(quoteStrippedCommand) : quoteStrippedCommand;
}

export function matchPatternInCommandTarget(command: string, pattern: BlacklistPattern): boolean {
  if (pattern.commandMatcher) {
    return pattern.commandMatcher(pattern.redactPaths ? redactPathTokens(command) : command);
  }
  const target = policyTarget(command, pattern.redactPaths);
  return pattern.pattern.test(target);
}

export function resolvePatternAlternative(name: string, alternative: string | (() => string), gitWorkflowMessage?: string): string {
  if (name === "git write op (MCP)" && gitWorkflowMessage) return gitWorkflowMessage;
  return resolveAlternative(alternative);
}

export function contentPolicyTargets(line: string, insideCodeBlock: boolean): { target: string; redactedTarget: string } {
  if (insideCodeBlock) {
    return {
      target: line,
      redactedTarget: redactPathTokens(line),
    };
  }

  const stripped = line
    .replace(/`[^`]+`/g, "")
    .replace(/"[^"]+"/g, "")
    .replace(/\b\w+\s*\([^)]*\)/g, "");
  return {
    target: stripped,
    redactedTarget: redactPathTokens(stripped),
  };
}

export function contentCommandCandidate(line: string): string {
  return line.trim()
    .replace(/^(?:[-*+>]\s+|\d+\.\s+)/, "")
    .replace(/^(?:run|execute|use)\s+/i, "");
}

export function payloadAwarePatternMatcher(
  command: string,
  pattern: BlacklistPattern,
  matcher: (candidateCommand: string, candidatePattern: BlacklistPattern) => boolean,
): boolean {
  return commandOrNestedPayloadMatches(command, (candidateCommand) => matcher(candidateCommand, pattern));
}

export function matchingPatternFindings(
  command: string,
  patterns: ReadonlyArray<BlacklistPattern>,
  matcher: (command: string, pattern: BlacklistPattern) => boolean,
  makeFinding: (pattern: BlacklistPattern) => Omit<BashPolicyFinding, "role" | "kind" | "topic"> & { topic?: BashPolicyTopic },
): BashPolicyFinding[] {
  return patterns.filter((candidate) => matcher(command, candidate)).map((pattern) => {
    const finding = makeFinding(pattern);
    return {
      ...finding,
      topic: finding.topic ?? pattern.topic ?? "read-only",
      role: "terminal-candidate",
      kind: "deny",
    };
  });
}
