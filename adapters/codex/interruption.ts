/**
 * Codex interruption message detector.
 *
 * Codex does not inject Claude Code-style interruption messages, so this
 * always returns false.
 *
 * @module adapters/codex/interruption
 */

export function isInterruptionMessage(_content: string): boolean {
  return false;
}
