import * as fs from 'fs';

export interface ErrorCheckResult {
  needsHaikuCheck: boolean;
  indicators: string[];
}

/**
 * Trim tool output to avoid context bloat.
 * Extracts only error-relevant lines or truncates if too long.
 */
export function trimToolOutput(output: string, maxLines = 20): string {
  const lines = output.split('\n');

  // Extract error-relevant lines
  const errorLines = lines.filter((l) =>
    /error|Error|ERROR|failed|FAILED|denied|DENIED/.test(l)
  );

  if (errorLines.length > 0) {
    // Return errors + context
    return errorLines.slice(0, maxLines).join('\n');
  }

  // No errors: return truncated output
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
 * Quick pattern check to determine if Haiku should be called.
 * Returns true only if error patterns or user frustration indicators are found.
 */
export function quickErrorCheck(transcript: string): ErrorCheckResult {
  const indicators: string[] = [];

  // Error patterns in tool results
  const errorPatterns = [
    /error TS\d+/i, // TypeScript errors
    /Error:/i, // General errors
    /failed|FAILED/, // Build failures
    /denied|DENIED/, // Hook denials
    /make: \*\*\*/, // Makefile errors
  ];

  // User frustration/directive patterns (narrowed to avoid false positives)
  const userPatterns = [
    /\bignore\b/i, // "ignore"
    /[A-Z]{5,}/, // 5+ consecutive caps (shouting)
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
    needsHaikuCheck: indicators.length > 0,
    indicators,
  };
}

interface TranscriptEntry {
  message?: {
    role: string;
    content: string | ContentBlock[];
  };
}

interface ContentBlock {
  type: string;
  text?: string;
  content?: string;
  tool_use_id?: string;
}

/**
 * Read transcript and extract messages including tool results.
 * Trims tool output to avoid context bloat.
 */
export async function readTranscriptForErrorCheck(
  transcriptPath: string,
  lines: number
): Promise<string> {
  const content = await fs.promises.readFile(transcriptPath, 'utf-8');
  const entries = content.trim().split('\n').slice(-lines);

  const result: string[] = [];

  for (const line of entries) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);

      if (!entry.message) continue;

      const { role, content: msgContent } = entry.message;

      if (role === 'user') {
        if (typeof msgContent === 'string') {
          result.push(`USER: ${msgContent}`);
        } else if (Array.isArray(msgContent)) {
          // Check for tool_result blocks
          for (const block of msgContent) {
            if (block.type === 'tool_result' && block.content) {
              const trimmed = trimToolOutput(block.content);
              result.push(`TOOL_RESULT: ${trimmed}`);
            } else if (block.type === 'text' && block.text) {
              result.push(`USER: ${block.text}`);
            }
          }
        }
      } else if (role === 'assistant' && Array.isArray(msgContent)) {
        const textBlocks = msgContent
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join(' ');
        if (textBlocks) {
          result.push(`ASSISTANT: ${textBlocks}`);
        }
      }
    } catch {
      // Skip malformed lines
    }
  }

  return result.join('\n');
}
