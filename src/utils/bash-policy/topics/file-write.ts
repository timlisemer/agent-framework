import { splitShellSegments } from "../analysis.js";
import { hasActiveFileRedirect } from "../analysis.js";
import { matchPatternInCommandTarget, matchingPatternFindings, payloadAwarePatternMatcher, resolveAlternative } from "../helpers.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";

export const SHELL_REDIRECT_DENY_REASON = "shell redirect to file";

export const FILE_WRITE_PATTERNS: BlacklistPattern[] = [
  { pattern: /\b(?:echo|printf)\b[^;|&\n\r]*\d?>>?\|?\s*(?![&(])\S/, name: "echo redirect", alternative: "Use Write tool", topic: "file-write" },
  { pattern: /\btee\s+(?:-[A-Za-z]+\s+)*\S+/, name: "tee file write", alternative: "Use Write tool", topic: "file-write" },
];

export function matchFileWritePattern(command: string, pattern: BlacklistPattern): boolean {
  return splitShellSegments(command).segments.some((segment) => matchPatternInCommandTarget(segment.trim(), pattern));
}

export function fileWritePolicyFindings(command: string): BashPolicyFinding[] {
  const findings: BashPolicyFinding[] = [];
  if (hasActiveFileRedirect(command)) {
    findings.push({
      topic: "file-write",
      role: "terminal-candidate",
      kind: "deny",
      name: "shell redirect",
      reason: SHELL_REDIRECT_DENY_REASON,
      alternative: SHELL_REDIRECT_DENY_REASON,
    });
  }

  findings.push(...matchingPatternFindings(
    command,
    FILE_WRITE_PATTERNS,
    (candidateCommand, pattern) => payloadAwarePatternMatcher(candidateCommand, pattern, matchFileWritePattern),
    (pattern) => ({
      topic: "file-write",
      name: pattern.name,
      reason: pattern.name,
      alternative: resolveAlternative(pattern.alternative),
    }),
  ));
  return findings;
}
