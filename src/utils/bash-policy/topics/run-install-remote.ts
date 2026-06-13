import { matchingPatternFindings, payloadAwarePatternMatcher, resolveAlternative } from "../helpers.js";
import { INSTALL_WORKAROUND_VARIANTS } from "../constants.js";
import type { BashPolicyFinding, BlacklistPattern } from "../types.js";

export const RUN_INSTALL_REMOTE_PATTERNS: BlacklistPattern[] = [
  { pattern: /\bnpm\s+install\b/, name: "npm install", alternative: "LLMs should not modify project dependencies", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bbun\s+install\b/, name: "bun install", alternative: "LLMs should not modify project dependencies", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bpnpm\s+install\b/, name: "pnpm install", alternative: "LLMs should not modify project dependencies", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bssh\s+/, name: "ssh", alternative: "Remote execution denied", topic: "run-install-remote" },

  { pattern: /\bmake\s+run(-\w+)?\b/, name: "make run", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bjust\s+run(-\w+)?\b/, name: "just run", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bnpm\s+run\s+(start|dev)\b/, name: "npm start/dev", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bbun\s+run\s+(start|dev)\b/, name: "bun start/dev", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bcargo\s+run\b/, name: "cargo run", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
  { pattern: /\bgo\s+run\b/, name: "go run", alternative: "Run commands not allowed", redactPaths: true, topic: "run-install-remote" },
];

export { INSTALL_WORKAROUND_VARIANTS };

export function runInstallRemotePolicyFindings(
  command: string,
  matcher: (command: string, pattern: BlacklistPattern) => boolean,
): BashPolicyFinding[] {
  return matchingPatternFindings(command, RUN_INSTALL_REMOTE_PATTERNS, (candidateCommand, pattern) =>
    payloadAwarePatternMatcher(candidateCommand, pattern, matcher), (pattern) => ({
    topic: "run-install-remote",
    name: pattern.name,
    category: pattern.name.includes("install") ? "install" : "run",
    reason: pattern.name,
    alternative: resolveAlternative(pattern.alternative),
  }));
}
