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

/**
 * Question patterns for detecting AI questions directed at user.
 * These should use AskUserQuestion tool instead of plain text.
 *
 * Pattern matching is case-insensitive and checks for common question forms
 * that clearly solicit user input.
 */
export const USER_DIRECTED_QUESTION_PATTERNS: ContentPattern[] = [
  { pattern: /which\b[^?]*\bdo you prefer\?/i, name: "preference question", message: "Use AskUserQuestion tool" },
  { pattern: /which\b[^?]*\bwould you prefer\?/i, name: "preference question", message: "Use AskUserQuestion tool" },
  { pattern: /which\b[^?]*\bapproach\b[^?]*\?/i, name: "approach question", message: "Use AskUserQuestion tool" },
  { pattern: /which\b[^?]*\boption\b[^?]*\?/i, name: "option question", message: "Use AskUserQuestion tool" },
  { pattern: /should I\b[^?]*\?/i, name: "should-I question", message: "Use AskUserQuestion tool" },
  { pattern: /do you want\b[^?]*\?/i, name: "want question", message: "Use AskUserQuestion tool" },
  { pattern: /would you like\b[^?]*\?/i, name: "like question", message: "Use AskUserQuestion tool" },
  { pattern: /shall I\b[^?]*\?/i, name: "shall-I question", message: "Use AskUserQuestion tool" },
  { pattern: /can I\b[^?]*\?/i, name: "can-I question", message: "Use AskUserQuestion tool" },
  { pattern: /do you prefer\b[^?]*\?/i, name: "preference question", message: "Use AskUserQuestion tool" },
];

/**
 * Patterns that indicate self-directed or rhetorical questions.
 * These should NOT be flagged as user-directed questions.
 */
const SELF_DIRECTED_PATTERNS = [
  /^I wonder/i,
  /^wondering/i,
  /^why does this/i,
  /^why is this/i,
  /^how does this/i,
  /^let me see/i,
];

/**
 * Detect AI questions directed at user that should use AskUserQuestion tool.
 * Returns array of detected question highlights for feedback.
 *
 * Only detects questions that:
 * 1. End with ? (question mark)
 * 2. Match user-directed patterns (should I, do you want, which approach, etc.)
 * 3. Do NOT match self-directed/rhetorical patterns
 */
export function detectUserDirectedQuestions(text: string): string[] {
  const highlights: string[] = [];

  // Must end with ? to be considered a question
  if (!text.trim().endsWith("?")) {
    return highlights;
  }

  // Check if it's self-directed (skip these)
  for (const pattern of SELF_DIRECTED_PATTERNS) {
    if (pattern.test(text.trim())) {
      return highlights;
    }
  }

  // Check for user-directed question patterns
  for (const { pattern, name, message } of USER_DIRECTED_QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      highlights.push(`[QUESTION: ${name}] "${text.trim().slice(0, 100)}..." → ${message}`);
      break; // Only report first match
    }
  }

  return highlights;
}

// ============================================================================
// STYLE DRIFT DETECTION
// ============================================================================

/**
 * Style change detection result.
 * Follows existing pattern: returns specific findings, not boolean.
 */
export interface StyleChange {
  type: "quote" | "semicolon" | "trailing_comma";
  direction: string; // e.g., "' → \"" or "added" or "removed"
  sample: string; // snippet of affected code
  violatesPreference?: boolean; // true if changing AWAY from preference
  matchesPreference?: boolean; // true if changing TOWARD preference
}

/**
 * Detect style changes between old and new content.
 * Returns list of changes with preference flags for fast-path decisions.
 *
 * @param oldStr - Original content
 * @param newStr - New content
 * @param quotePreference - "double" | "single" | null for quote preference
 */
export function detectStyleChanges(
  oldStr: string,
  newStr: string,
  quotePreference: "double" | "single" | null = "double"
): StyleChange[] {
  const changes: StyleChange[] = [];

  // Quote changes - compare counts
  const oldSingle = (oldStr.match(/'/g) || []).length;
  const newSingle = (newStr.match(/'/g) || []).length;
  const oldDouble = (oldStr.match(/"/g) || []).length;
  const newDouble = (newStr.match(/"/g) || []).length;

  if (oldSingle !== newSingle || oldDouble !== newDouble) {
    const goingToSingle = newSingle > oldSingle && newDouble <= oldDouble;
    const goingToDouble = newDouble > oldDouble && newSingle <= oldSingle;
    const direction = goingToDouble ? "' → \"" : goingToSingle ? "\" → '" : "mixed";

    changes.push({
      type: "quote",
      direction,
      sample: newStr.slice(0, 50),
      // Violation: going AWAY from preference
      violatesPreference:
        (quotePreference === "double" && goingToSingle) ||
        (quotePreference === "single" && goingToDouble),
      // Match: going TOWARD preference (cleanup)
      matchesPreference:
        (quotePreference === "double" && goingToDouble) ||
        (quotePreference === "single" && goingToSingle),
    });
  }

  // Semicolon changes - no preference, always needs LLM
  const oldSemis = (oldStr.match(/;/g) || []).length;
  const newSemis = (newStr.match(/;/g) || []).length;
  if (oldSemis !== newSemis) {
    changes.push({
      type: "semicolon",
      direction: newSemis > oldSemis ? "added" : "removed",
      sample: newStr.slice(0, 50),
    });
  }

  // Trailing comma changes - no preference, always needs LLM
  const oldTrailing = (oldStr.match(/,\s*[\n})\]]/g) || []).length;
  const newTrailing = (newStr.match(/,\s*[\n})\]]/g) || []).length;
  if (oldTrailing !== newTrailing) {
    changes.push({
      type: "trailing_comma",
      direction: newTrailing > oldTrailing ? "added" : "removed",
      sample: newStr.slice(0, 50),
    });
  }

  return changes;
}

/**
 * Format style changes as hints for LLM prompt injection.
 * Follows [TYPE: name] message format from other agents.
 */
export function formatStyleHints(changes: StyleChange[]): string {
  if (changes.length === 0) return "";

  const hints = changes.map((c) => {
    const message =
      c.type === "semicolon"
        ? c.direction === "added"
          ? "semicolons were added"
          : "semicolons were removed"
        : c.type === "trailing_comma"
          ? c.direction === "added"
            ? "trailing commas were added"
            : "trailing commas were removed"
          : `quote style changed: ${c.direction}`;
    return `[STYLE: ${c.type}] ${message}`;
  });

  return `=== STYLE CHANGES DETECTED ===
${hints.join("\n")}
=== END STYLE HINTS ===\n`;
}
