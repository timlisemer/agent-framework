/**
 * Content validation patterns for detecting violations in plans and documents.
 *
 * Categories:
 * - Rule violations: Time estimates, unrequested parameters
 * - Shared deterministic style-policy primitives
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
  // Solution branching - plans should be single path, not decision trees
  { pattern: /\boption\s+[a-z]:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
  { pattern: /\boption\s+\d+:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
  { pattern: /\bapproach\s+[a-z]:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
  { pattern: /\bapproach\s+\d+:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
  { pattern: /\balternative\s+[a-z]:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
  { pattern: /\balternative\s+\d+:/i, name: "solution branching", message: "Plan should have single approach, not multiple options" },
];

/**
 * Shared style-violation patterns.
 * Detect unrequested cosmetic changes.
 *
 * Common emoji ranges covering most used emojis in code/docs context.
 */
export const EMOJI_REGEX =
  /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]|[\u{2B50}-\u{2B55}]|[\u{203C}\u{2049}]|[\u{25AA}\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}]|[\u{00A9}\u{00AE}]|[\u{2122}\u{2139}]|[\u{3030}\u{303D}]|[\u{3297}\u{3299}]/gu;

/**
 * Verification heading regex - matches generic verification sections.
 * Catches: ## Verification, ### Verification Steps, ## Testing, # Test Plan, etc.
 */
const VERIFICATION_HEADING_REGEX = /^#{1,3}\s*(verification|testing|test plan)\b/im;

/**
 * Proper verification subsection regexes.
 * Plans must use these named subsections instead of generic headings.
 */
const ASSISTANT_VERIFICATION_REGEX = /assistant\s+verification/i;
const MANUAL_VERIFICATION_REGEX = /manual\s+(user\s+)?verification/i;

export interface MarkdownSectionRange {
  /** Byte offset of the heading line start. */
  start: number;
  /** Byte offset immediately after the heading line. */
  bodyStart: number;
  /** Byte offset where the section ends. */
  end: number;
}

export type MarkdownHeadingMatcher = string | RegExp | ((heading: string) => boolean);

export function matchesMarkdownHeading(heading: string, matcher: MarkdownHeadingMatcher): boolean {
  if (typeof matcher === "string") return heading.toLowerCase() === matcher.toLowerCase();
  if (matcher instanceof RegExp) return matcher.test(heading);
  return matcher(heading);
}

export function findMarkdownSectionRange(
  content: string,
  matcher: MarkdownHeadingMatcher,
): MarkdownSectionRange | null {
  let inFence = false;
  let matched: { level: number; start: number; bodyStart: number } | null = null;

  for (const lineMatch of content.matchAll(/^.*(?:\n|$)/gm)) {
    const line = lineMatch[0];
    if (!line) continue;
    const offset = lineMatch.index ?? 0;
    const lineText = line.endsWith("\n") ? line.slice(0, -1) : line;
    const trimmed = lineText.trimStart();
    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || trimmed.startsWith(">")) continue;

    const heading = lineText.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;

    const level = heading[1].length;
    if (matched && level <= matched.level) {
      return { ...matched, end: offset };
    }
    if (!matched && matchesMarkdownHeading(heading[2].trim(), matcher)) {
      matched = {
        level,
        start: offset,
        bodyStart: offset + line.length,
      };
    }
  }

  return matched ? { ...matched, end: content.length } : null;
}

export function excludeMarkdownSectionBodies(
  content: string,
  matchers: readonly MarkdownHeadingMatcher[],
): string {
  const chars = content.split("");
  const ranges = matchers
    .map((matcher) => findMarkdownSectionRange(content, matcher))
    .filter((range): range is MarkdownSectionRange => range !== null);

  for (const range of ranges) {
    for (let i = range.bodyStart; i < range.end; i++) {
      if (chars[i] !== "\n") chars[i] = " ";
    }
  }

  return chars.join("");
}

/**
 * Detect plan clearing: Write that replaces the plan with placeholder/stub content.
 * A plan Write must contain substantive content (5+ non-empty lines).
 * Plans shorter than 5 lines or containing only a title with no body are violations.
 */
export function getPlanClearingHighlights(content: string): string[] {
  const nonEmptyLines = content.split("\n").filter((l) => l.trim().length > 0);
  if (nonEmptyLines.length < 5) {
    return [
      `[VIOLATION: plan clearing] Plan content has only ${nonEmptyLines.length} non-empty line(s) - this is placeholder/stub content. Use Bash rm to delete the plan file instead of writing placeholder content.`,
    ];
  }
  return [];
}

/**
 * Detect verification sections that lack proper "Assistant Verification"
 * or "Manual User Verification" subsections.
 * Returns highlighted violations for injection into agent prompts.
 *
 * Plans with verification content MUST use named subsections:
 * - "Assistant Verification" for AI-executed checks (the agent-framework check MCP)
 * - "Manual User Verification" for user-executed steps (ssh, curl, browser)
 * Having only one subsection is fine; having neither is a violation.
 */
export function getVerificationStructureHighlights(content: string): string[] {
  const headingMatch = content.match(VERIFICATION_HEADING_REGEX);
  if (!headingMatch) return [];

  const hasAssistant = ASSISTANT_VERIFICATION_REGEX.test(content);
  const hasManual = MANUAL_VERIFICATION_REGEX.test(content);

  if (!hasAssistant && !hasManual) {
    return [
      `[VIOLATION: generic verification] "${headingMatch[0].trim()}" → Split into "## Assistant Verification" (for the agent-framework check MCP) and/or "## Manual User Verification" (for user-executed steps like ssh, curl, browser)`,
    ];
  }

  return [];
}

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
 * Splits text into sentences and checks each independently so questions
 * embedded mid-response are caught (not just when the entire text ends with ?).
 *
 * Only detects sentences that:
 * 1. End with ? (question mark)
 * 2. Match user-directed patterns (should I, do you want, which approach, etc.)
 * 3. Do NOT match self-directed/rhetorical patterns
 */
export function detectUserDirectedQuestions(text: string): string[] {
  const highlights: string[] = [];

  // Split into sentences on . ! or newline boundaries, keep ? attached
  const sentences = text.split(/(?<=[.!])\s+|\n+/).filter((s) => s.trim().length > 0);

  for (const sentence of sentences) {
    const trimmed = sentence.trim();

    // Sentence must end with ? to be considered a question
    if (!trimmed.endsWith("?")) continue;

    // Check if it's self-directed (skip these)
    let selfDirected = false;
    for (const pattern of SELF_DIRECTED_PATTERNS) {
      if (pattern.test(trimmed)) {
        selfDirected = true;
        break;
      }
    }
    if (selfDirected) continue;

    // Check for user-directed question patterns
    for (const { pattern, name, message } of USER_DIRECTED_QUESTION_PATTERNS) {
      if (pattern.test(trimmed)) {
        highlights.push(`[QUESTION: ${name}] "${trimmed.slice(0, 100)}..." → ${message}`);
        break; // Only report first match per sentence
      }
    }
  }

  return highlights;
}

// ============================================================================
// STYLE PREFERENCES
// ============================================================================

export type QuotePreference = "double" | "single" | null;

export interface QuotePreferenceAnalysis {
  preference: QuotePreference;
  conflict: boolean;
}

/** Analyze explicit, non-negated quote requirements in instruction text. */
export function analyzeQuotePreferences(content: string): QuotePreferenceAnalysis {
  const preferences = new Set<Exclude<QuotePreference, null>>();
  const policyVerb = "(?:use|uses|using|prefer|prefers|preferring|require|requires|requiring)";
  for (const clause of content.split(/[;\n]/)) {
    const normalized = clause.toLowerCase();
    const negates = (quote: "double" | "single") =>
      new RegExp(
        `\\b(?:(?:do not|don't|never)\\s+${policyVerb}|avoid(?:\\s+${policyVerb})?)\\s+(?:only\\s+)?${quote} quotes?\\b`,
      ).test(normalized);
    const affirms = (quote: "double" | "single") =>
      new RegExp(`\\b(?:${policyVerb}|standard(?: is|:)?)(?:\\s+only)?\\s+${quote} quotes?\\b`).test(normalized);
    if (affirms("double") && !negates("double")) preferences.add("double");
    if (affirms("single") && !negates("single")) preferences.add("single");
  }
  return {
    preference: preferences.size === 1 ? preferences.values().next().value ?? null : null,
    conflict: preferences.size > 1,
  };
}
