/**
 * Claude Code internal interruption message detector.
 *
 * When a user presses Escape during tool execution, Claude Code injects
 * internal messages into the tool result. These must be filtered out so
 * hooks don't misattribute them as user intent.
 *
 * @module adapters/claude/interruption
 */

const CLAUDE_CODE_INTERRUPTION_PATTERNS = [
  /The user doesn't want to take this action right now/i,
  /STOP what you are doing and wait for the user/i,
  /\[Request interrupted by user.*\]/i,
];

export function isInterruptionMessage(content: string): boolean {
  return CLAUDE_CODE_INTERRUPTION_PATTERNS.some((p) => p.test(content));
}
