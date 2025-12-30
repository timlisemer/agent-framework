import * as fs from 'fs';

/**
 * Filter for what types of messages to include in transcript
 */
export enum TranscriptFilter {
  USER_ONLY = 'user_only',
  AI_ONLY = 'ai_only',
  BOTH = 'both',
  BOTH_WITH_TOOLS = 'both_with_tools',
}

/**
 * Number of messages to include in transcript
 */
export enum MessageLimit {
  ONE = 1,
  THREE = 3,
  FIVE = 5,
  TEN = 10,
  TWENTY = 20,
  THIRTY = 30,
  FIFTY = 50,
  ALL = -1,
}

export interface TranscriptOptions {
  filter: TranscriptFilter;
  limit: MessageLimit;
  trimToolOutput?: boolean;
  maxToolOutputLines?: number;
  excludeSystemReminders?: boolean;
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  index: number;
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

/**
 * Quick pattern check to determine if error acknowledgment should be checked.
 * Returns true only if error patterns or user frustration indicators are found.
 */
export function hasErrorPatterns(transcript: string): ErrorCheckResult {
  const indicators: string[] = [];

  const errorPatterns = [
    /error TS\d+/i,
    /Error:/i,
    /failed|FAILED/,
    /denied|DENIED/,
    /make: \*\*\*/,
  ];

  const userPatterns = [
    /\bignore\b/i,
    /[A-Z]{5,}/,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(transcript)) {
      indicators.push(`error:${pattern.source}`);
    }
  }

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
 * Read transcript and return structured messages array
 */
export async function readTranscriptStructured(
  transcriptPath: string,
  options: TranscriptOptions
): Promise<TranscriptMessage[]> {
  const {
    filter,
    limit,
    trimToolOutput: shouldTrim = filter === TranscriptFilter.BOTH_WITH_TOOLS,
    maxToolOutputLines = 20,
    excludeSystemReminders = true,
  } = options;

  const content = await fs.promises.readFile(transcriptPath, 'utf-8');
  const allLines = content.trim().split('\n');

  const linesToProcess =
    limit === MessageLimit.ALL ? allLines : allLines.slice(-limit * 3);

  const messages: TranscriptMessage[] = [];

  for (let i = 0; i < linesToProcess.length; i++) {
    const line = linesToProcess[i];
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      if (!entry.message) continue;

      const { role, content: msgContent } = entry.message;

      if (role === 'user') {
        if (filter === TranscriptFilter.AI_ONLY) continue;

        if (typeof msgContent === 'string') {
          if (excludeSystemReminders && msgContent.startsWith('<system-reminder>')) {
            continue;
          }
          messages.push({ role: 'user', content: msgContent, index: i });
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'tool_result' && filter === TranscriptFilter.BOTH_WITH_TOOLS) {
              const toolContent = extractToolResultContent(block);
              if (toolContent) {
                const finalContent = shouldTrim
                  ? trimToolOutput(toolContent, maxToolOutputLines)
                  : toolContent;
                messages.push({ role: 'tool_result', content: finalContent, index: i });
              }
            } else if (block.type === 'text' && block.text) {
              if (excludeSystemReminders && block.text.startsWith('<system-reminder>')) {
                continue;
              }
              messages.push({ role: 'user', content: block.text, index: i });
            }
          }
        }
      } else if (role === 'assistant') {
        if (filter === TranscriptFilter.USER_ONLY) continue;

        const text = extractTextFromContent(msgContent);
        if (text) {
          messages.push({ role: 'assistant', content: text, index: i });
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  if (limit === MessageLimit.ALL) {
    return messages;
  }
  return messages.slice(-limit);
}

/**
 * Read transcript and return formatted string
 */
export async function readTranscript(
  transcriptPath: string,
  options: TranscriptOptions
): Promise<string> {
  const messages = await readTranscriptStructured(transcriptPath, options);

  return messages
    .map((msg) => {
      switch (msg.role) {
        case 'user':
          return `USER: ${msg.content}`;
        case 'assistant':
          return `ASSISTANT: ${msg.content}`;
        case 'tool_result':
          return `TOOL_RESULT: ${msg.content}`;
      }
    })
    .join('\n\n');
}
