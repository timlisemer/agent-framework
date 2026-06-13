import { matchingPatternFindings, payloadAwarePatternMatcher } from "../helpers.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";

export const scriptingLanguageAction = "Scripting language execution denied. Use dedicated internal tools and read-only Bash commands instead.";

export const SCRIPT_EXEC_PATTERNS: BlacklistPattern[] = [
  { pattern: /(?:^|[\s;&|])python(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?python\s+\S|\bpython\s+(?:-[\w-]+|<PATH>))/, name: "python", alternative: scriptingLanguageAction, redactPaths: true, topic: "script-exec" },
  { pattern: /(?:^|[\s;&|])python3(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?python3\s+\S|\bpython3\s+(?:-[\w-]+|<PATH>))/, name: "python3", alternative: scriptingLanguageAction, redactPaths: true, topic: "script-exec" },
  { pattern: /(?:^|[\s;&|])node(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?node\s+\S|\bnode\s+(?:-[\w-]+|<PATH>))/, name: "node", alternative: scriptingLanguageAction, redactPaths: true, topic: "script-exec" },
  { pattern: /(?:^|[\s;&|])ruby(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?ruby\s+\S|\bruby\s+(?:-[\w-]+|<PATH>))/, name: "ruby", alternative: scriptingLanguageAction, redactPaths: true, topic: "script-exec" },
  { pattern: /(?:^|[\s;&|])perl(?:$|\s)/, contentPattern: /(?:^\s*(?:[-*+>]\s+|\d+\.\s+)?perl\s+\S|\bperl\s+(?:-[\w-]+|<PATH>))/, name: "perl", alternative: scriptingLanguageAction, redactPaths: true, topic: "script-exec" },
];

export function scriptExecPolicyFindings(command: string, matcher: (command: string, pattern: BlacklistPattern) => boolean): BashPolicyFinding[] {
  const payloadAwareMatcher = (candidateCommand: string, pattern: BlacklistPattern): boolean =>
    payloadAwarePatternMatcher(candidateCommand, pattern, matcher);

  return matchingPatternFindings(command, SCRIPT_EXEC_PATTERNS, payloadAwareMatcher, (pattern) => ({
    topic: "script-exec",
    name: pattern.name,
    reason: pattern.name,
    alternative: scriptingLanguageAction,
  }));
}
