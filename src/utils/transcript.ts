import * as fs from 'fs';

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  index: number;
}

/**
 * Counts for each message type.
 * Each field specifies exact number of that type to collect.
 * The scanner will read backwards until these counts are satisfied (or transcript exhausted).
 */
export interface MessageCounts {
  user?: number;
  assistant?: number;
  toolResult?: number;
}

/**
 * Options for reading transcript with guaranteed counts.
 */
export interface TranscriptReadOptions {
  /**
   * Exact counts per message type.
   * The scanner will read backwards until these counts are satisfied
   * (or transcript is exhausted).
   */
  counts: MessageCounts;

  /**
   * Options for tool result processing.
   */
  toolResultOptions?: {
    /** Trim tool output to error-relevant lines */
    trim?: boolean;
    /** Max lines to include per tool result (default: 20) */
    maxLines?: number;
    /** Tool names to exclude from results */
    excludeToolNames?: string[];
  };

  /** Exclude system reminder messages (default: true) */
  excludeSystemReminders?: boolean;

  /** Exclude slash command system prompts (default: true) */
  excludeSlashCommandPrompts?: boolean;
}

/**
 * Collected messages with guaranteed counts per type.
 */
export interface TranscriptReadResult {
  /** User messages (length === min(counts.user, available)) */
  user: TranscriptMessage[];
  /** Assistant messages */
  assistant: TranscriptMessage[];
  /** Tool result messages */
  toolResult: TranscriptMessage[];
  /** Total messages collected across all types */
  totalCount: number;
}

export interface ErrorCheckResult {
  needsCheck: boolean;
  indicators: string[];
}

interface ContentBlock {
  type: string;
  text?: string;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  name?: string; // Tool name for tool_use blocks
  id?: string; // Tool use ID for tool_use blocks
}

interface TranscriptEntry {
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
}

/**
 * Trim tool output to avoid context bloat.
 * Extracts only error-relevant lines or truncates if too long.
 */
export function trimToolOutput(output: string, maxLines = 20): string {
  const lines = output.split('\n');

  const errorLines = lines.filter((l) =>
    /error|Error|ERROR|failed|FAILED|denied|DENIED|warning|Warning/.test(l)
  );

  if (errorLines.length > 0) {
    return errorLines.slice(0, maxLines).join('\n');
  }

  if (lines.length > maxLines) {
    const half = Math.floor(maxLines / 2);
    return (
      lines.slice(0, half).join('\n') +
      '\n[...truncated...]\n' +
      lines.slice(-half).join('\n')
    );
  }
  return output;
}

export interface ErrorCheckOptions {
  toolResultsOnly?: boolean; // Only check TOOL_RESULT lines for error patterns
}

/**
 * Quick pattern check to determine if error acknowledgment should be checked.
 * Returns true only if error patterns or user frustration indicators are found.
 */
export function hasErrorPatterns(
  transcript: string,
  options?: ErrorCheckOptions
): ErrorCheckResult {
  const indicators: string[] = [];

  // If toolResultsOnly is true, only check TOOL_RESULT lines for errors
  // This prevents false positives from Read tool content (source code)
  const textToCheck = options?.toolResultsOnly
    ? transcript
        .split('\n')
        .filter((l) => l.startsWith('TOOL_RESULT:'))
        .join('\n')
    : transcript;

  const errorPatterns = [
    /error TS\d+/i,
    /Error:/i,
    /failed|FAILED/,
    /denied|DENIED/,
    /make: \*\*\*/,
  ];

  const userPatterns = [
    /\bignore\b/i, // "ignore this"
    /[A-Z]{5,}/, // All caps words (5+ chars) - triggers Haiku to evaluate
    /\bstop\s+(doing|trying|that)\b/i, // "stop doing that"
    /\bI\s+(said|told|asked)\b/i, // "I said to..."
    /\bwrong\b.*\byou\b/i, // "wrong, you should..."
  ];

  // Check error patterns against tool results (or full transcript)
  for (const pattern of errorPatterns) {
    if (pattern.test(textToCheck)) {
      indicators.push(`error:${pattern.source}`);
    }
  }

  // Always check user patterns against full transcript (user frustration can be anywhere)
  for (const pattern of userPatterns) {
    if (pattern.test(transcript)) {
      indicators.push(`user:${pattern.source}`);
    }
  }

  return {
    needsCheck: indicators.length > 0,
    indicators,
  };
}

/**
 * Detect if content is a slash command system prompt.
 * These have YAML frontmatter with allowed-tools/description metadata.
 */
function isSlashCommandPrompt(content: string): boolean {
  // Check for YAML frontmatter pattern at start
  if (!content.startsWith("---")) {
    return false;
  }

  // Look for slash command metadata indicators
  const frontmatterEnd = content.indexOf("---", 3);
  if (frontmatterEnd === -1) {
    return false;
  }

  const frontmatter = content.slice(0, frontmatterEnd + 3);
  return /allowed-tools:|description:/.test(frontmatter);
}

function extractTextFromContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text!)
      .join(' ');
  }
  return '';
}

function extractToolResultContent(block: ContentBlock): string {
  if (!block.content) return '';
  if (typeof block.content === 'string') {
    return block.content;
  }
  if (Array.isArray(block.content)) {
    return block.content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text!)
      .join(' ');
  }
  return '';
}

/**
 * Read transcript with guaranteed message counts per type.
 *
 * Scans backwards through the transcript file until the requested
 * count of each message type is collected (or file is exhausted).
 *
 * @example
 * // Get exactly 10 user messages for plan validation
 * const result = await readTranscriptExact(transcriptPath, {
 *   counts: { user: 10 }
 * });
 * // result.user.length === 10 (or fewer if not enough in transcript)
 *
 * @example
 * // Get 5 of each type for context
 * const result = await readTranscriptExact(transcriptPath, {
 *   counts: { user: 5, assistant: 5, toolResult: 3 },
 *   toolResultOptions: { trim: true, maxLines: 20 }
 * });
 */
export async function readTranscriptExact(
  transcriptPath: string,
  options: TranscriptReadOptions
): Promise<TranscriptReadResult> {
  const {
    counts,
    toolResultOptions = {},
    excludeSystemReminders = true,
    excludeSlashCommandPrompts = true,
  } = options;

  const targetUser = counts.user ?? 0;
  const targetAssistant = counts.assistant ?? 0;
  const targetToolResult = counts.toolResult ?? 0;

  const content = await fs.promises.readFile(transcriptPath, 'utf-8');
  const allLines = content.trim().split('\n');

  const collected: TranscriptReadResult = {
    user: [],
    assistant: [],
    toolResult: [],
    totalCount: 0,
  };

  // Map tool_use_id -> tool_name for filtering tool_results
  const toolUseIdToName = new Map<string, string>();

  // First pass: build tool_use ID map from entire file
  for (const line of allLines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      if (entry.message?.role === 'assistant' && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'tool_use' && block.id && block.name) {
            toolUseIdToName.set(block.id, block.name);
          }
        }
      }
    } catch {
      // Skip malformed
    }
  }

  // Second pass: scan backwards collecting messages until quotas met
  for (let i = allLines.length - 1; i >= 0; i--) {
    // Early exit if all quotas met
    if (
      collected.user.length >= targetUser &&
      collected.assistant.length >= targetAssistant &&
      collected.toolResult.length >= targetToolResult
    ) {
      break;
    }

    try {
      const entry: TranscriptEntry = JSON.parse(allLines[i]);
      if (!entry.message) continue;

      const { role, content: msgContent } = entry.message;

      if (role === 'user') {
        processUserEntry(msgContent, i, collected, {
          targetUser,
          targetToolResult,
          excludeSystemReminders,
          excludeSlashCommandPrompts,
          toolResultOptions,
          toolUseIdToName,
        });
      } else if (role === 'assistant' && collected.assistant.length < targetAssistant) {
        const text = extractTextFromContent(msgContent);
        if (text) {
          collected.assistant.unshift({ role: 'assistant', content: text, index: i });
        }
      }
    } catch {
      // Skip malformed
    }
  }

  collected.totalCount =
    collected.user.length + collected.assistant.length + collected.toolResult.length;

  return collected;
}

/**
 * Process a user entry (may contain text blocks and/or tool_result blocks)
 */
function processUserEntry(
  msgContent: string | ContentBlock[],
  lineIndex: number,
  collected: TranscriptReadResult,
  config: {
    targetUser: number;
    targetToolResult: number;
    excludeSystemReminders: boolean;
    excludeSlashCommandPrompts: boolean;
    toolResultOptions: TranscriptReadOptions['toolResultOptions'];
    toolUseIdToName: Map<string, string>;
  }
): void {
  const {
    targetUser,
    targetToolResult,
    excludeSystemReminders,
    excludeSlashCommandPrompts,
    toolResultOptions,
    toolUseIdToName,
  } = config;
  const { trim = false, maxLines = 20, excludeToolNames = [] } = toolResultOptions ?? {};

  if (typeof msgContent === 'string') {
    if (excludeSystemReminders && msgContent.startsWith('<system-reminder>')) {
      return;
    }
    if (excludeSlashCommandPrompts && isSlashCommandPrompt(msgContent)) {
      return;
    }
    if (collected.user.length < targetUser) {
      collected.user.unshift({ role: 'user', content: msgContent, index: lineIndex });
    }
  } else if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (block.type === 'tool_result' && collected.toolResult.length < targetToolResult) {
        // Check if this tool should be excluded
        if (block.tool_use_id && excludeToolNames.length > 0) {
          const toolName = toolUseIdToName.get(block.tool_use_id);
          if (toolName && excludeToolNames.includes(toolName)) {
            continue;
          }
        }

        let toolContent = extractToolResultContent(block);
        if (trim && toolContent) {
          toolContent = trimToolOutput(toolContent, maxLines);
        }
        if (toolContent) {
          collected.toolResult.unshift({ role: 'tool_result', content: toolContent, index: lineIndex });
        }
      } else if (block.type === 'text' && block.text) {
        if (excludeSystemReminders && block.text.startsWith('<system-reminder>')) {
          continue;
        }
        if (excludeSlashCommandPrompts && isSlashCommandPrompt(block.text)) {
          continue;
        }
        if (collected.user.length < targetUser) {
          collected.user.unshift({ role: 'user', content: block.text, index: lineIndex });
        }
      }
    }
  }
}

/**
 * Format TranscriptReadResult as string for agent prompts.
 * Merges all message types, sorts by original index, formats with role prefixes.
 */
export function formatTranscriptResult(result: TranscriptReadResult): string {
  const allMessages = [
    ...result.user.map((m) => ({ ...m, prefix: 'USER' })),
    ...result.assistant.map((m) => ({ ...m, prefix: 'ASSISTANT' })),
    ...result.toolResult.map((m) => ({ ...m, prefix: 'TOOL_RESULT' })),
  ].sort((a, b) => a.index - b.index);

  return allMessages.map((m) => `${m.prefix}: ${m.content}`).join('\n\n');
}
