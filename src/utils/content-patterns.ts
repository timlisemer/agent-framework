/**
 * Content validation patterns for detecting violations in plans and documents.
 *
 * Categories:
 * - Rule violations: Time estimates, unrequested parameters
 * - Style violations: Emoji additions, quote changes
 */

export interface ContentPattern {
  pattern: RegExp;
  name: string;
  message: string;
}

/**
 * Rule violation patterns for plan-validate and claude-md-validate.
 * Detect over-engineering and unrequested additions.
 */
export const RULE_VIOLATION_PATTERNS: ContentPattern[] = [
  // Time estimates - various formats
  { pattern: /\b\d+(-\d+)?\s*h(ours?)?\b/i, name: "time estimate", message: "Remove time estimates from plans" },
  { pattern: /\b\d+(-\d+)?\s*(days?|weeks?|months?)\b/i, name: "time estimate", message: "Remove time estimates from plans" },
  { pattern: /\best\.?\s*time\b/i, name: "time estimate header", message: "Remove time estimate columns" },
  { pattern: /\btotal\s*(estimated\s*)?time\b/i, name: "total time estimate", message: "Remove time estimates from plans" },
  { pattern: /\b(week|day|month)\s*\d+:/i, name: "timeline marker", message: "Remove timeline markers from plans" },
  { pattern: /\btakes?\s+\d+/i, name: "duration estimate", message: "Remove duration estimates" },
];

/**
 * Style violation patterns for style-drift agent.
 * Detect unrequested cosmetic changes.
 *
 * Common emoji ranges covering most used emojis in code/docs context.
 */
export const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{203C}\u{2049}]|[\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]|[\u{00A9}\u{00AE}]|[\u{2122}\u{2139}]|[\u{3030}\u{303D}]|[\u{3297}\u{3299}]/gu;

/**
 * Scan content for rule violations.
 * Returns highlighted violations for injection into agent prompts.
 */
export function getRuleViolationHighlights(content: string): string[] {
  const highlights: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    for (const { pattern, name, message } of RULE_VIOLATION_PATTERNS) {
      if (pattern.test(line)) {
        highlights.push(`[VIOLATION: ${name}] "${line.trim()}" → ${message}`);
        break;
      }
    }
  }

  return highlights;
}

/**
 * Detect emoji additions between old and new content.
 */
export function detectEmojiAddition(oldStr: string, newStr: string): string[] {
  const oldEmojis = new Set(oldStr.match(EMOJI_REGEX) || []);
  const newEmojis = newStr.match(EMOJI_REGEX) || [];
  const addedEmojis = newEmojis.filter((e) => !oldEmojis.has(e));
  return [...new Set(addedEmojis)];
}
