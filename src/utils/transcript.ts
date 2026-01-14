import * as fs from "fs";

/**
 * Claude Code Interruption Message Filter
 *
 * When a user interrupts a tool call in Claude Code (by pressing Escape),
 * Claude Code injects an internal message into the tool result like:
 *
 *   "The user doesn't want to take this action right now. STOP what you are
 *    doing and wait for the user to tell you how to proceed."
 *
 * or:
 *
 *   "[Request interrupted by user for tool use]"
 *
 * These messages get logged as tool_result content in the transcript. When
 * hooks (like response-align) read the transcript, they see these messages
 * in RECENT TOOL RESULTS and pass them to the LLM for alignment checking.
 *
 * The LLM then misinterprets "STOP what you are doing" as something the USER
 * said, leading to false positives like:
 *
 *   "Error: First response misalignment: User said 'STOP what you are doing'
 *    in the recent tool results..."
 *
 * THE USER NEVER SAID THIS - Claude Code's internal interruption handler did.
 *
 * These patterns detect and filter out Claude Code's internal interruption
 * messages to prevent this misattribution. Legitimate user content in tool
 * results (like AskUserQuestion answers) is preserved.
 */
const CLAUDE_CODE_INTERRUPTION_PATTERNS = [
  // Message injected when user presses Escape during tool execution
  /The user doesn't want to take this action right now/i,
  // The "STOP" directive that gets misattributed as user speech
  /STOP what you are doing and wait for the user/i,
  // Explicit interruption markers in tool results
  /\[Request interrupted by user.*\]/i,
];

/**
 * Check if tool result content is a Claude Code internal interruption message.
 *
 * Returns true if the content matches any of the known Claude Code interruption
 * patterns. These should be filtered out of tool results to prevent hooks from
 * misattributing them as user intent.
 *
 * @param content - The tool result content to check
 * @returns true if this is a Claude Code interruption message, false otherwise
 */
function isClaudeCodeInterruption(content: string): boolean {
  return CLAUDE_CODE_INTERRUPTION_PATTERNS.some((p) => p.test(content));
}

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool_result';
  content: string;
  index: number;
}

/**
 * Count specification for a message type.
 * Can be a simple number (backward compatible) or an object with staleness.
 */
export interface CountSpec {
  /** Number of this message type to collect */
  count: number;
  /**
   * Maximum transcript lines from scan start (end of file).
   * Messages found beyond this distance are considered stale and excluded.
   * Measured in raw transcript entries (lines), not filtered message types.
   */
  maxStale?: number;
}

/**
 * Counts for each message type.
 * Each field specifies exact number of that type to collect.
 * The scanner will read backwards until these counts are satisfied (or transcript exhausted).
 *
 * Each field can be:
 * - A number: backward compatible, no staleness check
 * - A CountSpec object: { count: N, maxStale?: M }
 */
export interface MessageCounts {
  user?: number | CountSpec;
  assistant?: number | CountSpec;
  toolResult?: number | CountSpec;
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

  /**
   * Always include the first user message (initial request).
   * Useful for plan validation where the original task context matters.
   * If true, scans forward from line 0 after backwards scan and prepends
   * the first user message if not already collected.
   */
  includeFirstUserMessage?: boolean;

  /**
   * Extract slash command context from the transcript.
   * If true, scans for slash command system prompts and extracts metadata
   * (command name, allowed-tools) for use in appeal decisions.
   */
  includeSlashCommandContext?: boolean;

  /**
   * Detect plan approval and inject synthetic user message.
   * If true, scans tool results for ExitPlanMode approval and adds
   * a synthetic user message indicating the plan was approved.
   */
  detectPlanApproval?: boolean;
}

/**
 * Extracted slash command metadata.
 */
export interface SlashCommandContext {
  /** The slash command name (e.g., "commit", "push") */
  commandName: string;
  /** Description from the slash command frontmatter */
  description?: string;
  /** Allowed tools from the slash command frontmatter */
  allowedTools?: string[];
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
  /** Slash command context if includeSlashCommandContext was true and a slash command was found */
  slashCommandContext?: SlashCommandContext;
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

  // Only check USER: lines for user frustration patterns
  // (avoids false positives from ASSISTANT/TOOL_RESULT prefixes matching [A-Z]{5,})
  const userLines = transcript
    .split('\n')
    .filter((l) => l.startsWith('USER:'))
    .join('\n');

  for (const pattern of userPatterns) {
    if (pattern.test(userLines)) {
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
 * These have YAML frontmatter with allowed-tools/description metadata,
 * OR contain body patterns that indicate slash command instructions.
 */
function isSlashCommandPrompt(content: string): boolean {
  // Check for YAML frontmatter pattern at start
  if (content.startsWith("---")) {
    const frontmatterEnd = content.indexOf("---", 3);
    if (frontmatterEnd !== -1) {
      const frontmatter = content.slice(0, frontmatterEnd + 3);
      if (/allowed-tools:|description:/.test(frontmatter)) {
        return true;
      }
    }
  }

  // Check for slash command body patterns (when frontmatter is stripped)
  // These patterns indicate slash command instructions, not user constraints
  const bodyPatterns = [
    /IMMEDIATELY call the mcp__/i,
    /CRITICAL:.*(?:Do NOT|only use).*(?:tools?|mcp)/i,
    /allowed-tools.*mcp__/i,
  ];

  for (const pattern of bodyPatterns) {
    if (pattern.test(content)) {
      return true;
    }
  }

  return false;
}

/**
 * Extract slash command metadata from a slash command system prompt.
 * Returns null if the content is not a slash command prompt.
 *
 * Parses YAML frontmatter to extract:
 * - description: Human-readable description of the command
 * - allowed-tools: List of MCP tools this command is allowed to use
 *
 * Also attempts to infer the command name from the content or allowed-tools.
 */
function extractSlashCommandMetadata(content: string): SlashCommandContext | null {
  // Must have YAML frontmatter
  if (!content.startsWith("---")) {
    return null;
  }

  const frontmatterEnd = content.indexOf("---", 3);
  if (frontmatterEnd === -1) {
    return null;
  }

  const frontmatter = content.slice(3, frontmatterEnd).trim();
  if (!/allowed-tools:|description:/.test(frontmatter)) {
    return null;
  }

  // Parse frontmatter fields
  let description: string | undefined;
  let allowedTools: string[] | undefined;
  let commandName: string | undefined;

  // Extract description
  const descMatch = frontmatter.match(/description:\s*(.+)/);
  if (descMatch) {
    description = descMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  // Extract allowed-tools (can be comma-separated or YAML list)
  const toolsMatch = frontmatter.match(/allowed-tools:\s*(.+)/);
  if (toolsMatch) {
    const toolsStr = toolsMatch[1].trim();
    allowedTools = toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
  }

  // Infer command name from allowed-tools or description
  if (allowedTools && allowedTools.length > 0) {
    // Look for mcp__agent-framework__<command> pattern
    for (const tool of allowedTools) {
      const mcpMatch = tool.match(/mcp__agent-framework__(\w+)/);
      if (mcpMatch) {
        commandName = mcpMatch[1]; // "commit", "push", "confirm", etc.
        break;
      }
    }
  }

  // Fallback: try to infer from description
  if (!commandName && description) {
    const cmdMatch = description.match(/\b(commit|push|confirm|check)\b/i);
    if (cmdMatch) {
      commandName = cmdMatch[1].toLowerCase();
    }
  }

  // If we couldn't determine command name, this isn't useful
  if (!commandName) {
    return null;
  }

  return {
    commandName,
    description,
    allowedTools,
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
 * Normalize a count specification to a consistent format.
 *
 * Handles both simple numbers (backward compatible) and CountSpec objects.
 * This allows existing configs like `user: 3` to work alongside new configs
 * like `user: { count: 1, maxStale: 1 }`.
 *
 * @param spec - Either a number, CountSpec, or undefined
 * @returns Normalized object with count and optional maxStale
 */
function normalizeCount(
  spec: number | CountSpec | undefined
): { count: number; maxStale?: number } {
  if (spec === undefined) return { count: 0 };
  if (typeof spec === "number") return { count: spec };
  return { count: spec.count, maxStale: spec.maxStale };
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
    includeFirstUserMessage = false,
    includeSlashCommandContext = false,
    detectPlanApproval = false,
  } = options;

  // Normalize count specs to handle both simple numbers and CountSpec objects.
  // This enables backward compatibility: `user: 3` works alongside `user: { count: 1, maxStale: 1 }`.
  const userSpec = normalizeCount(counts.user);
  const assistantSpec = normalizeCount(counts.assistant);
  const toolResultSpec = normalizeCount(counts.toolResult);

  const targetUser = userSpec.count;
  const targetAssistant = assistantSpec.count;
  const targetToolResult = toolResultSpec.count;

  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");

  const collected: TranscriptReadResult = {
    user: [],
    assistant: [],
    toolResult: [],
    totalCount: 0,
  };

  // Map tool_use_id -> tool_name for filtering tool_results
  const toolUseIdToName = new Map<string, string>();

  // Track slash command context if requested (scan backwards, use most recent)
  let slashCommandContext: SlashCommandContext | undefined;

  // First pass: build tool_use ID map from entire file
  // Also extract slash command context if requested
  for (const line of allLines) {
    try {
      const entry: TranscriptEntry = JSON.parse(line);
      if (entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
        for (const block of entry.message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolUseIdToName.set(block.id, block.name);
          }
        }
      }

      // Extract slash command context from user messages (forward scan, last one wins)
      if (includeSlashCommandContext && entry.message?.role === "user") {
        const msgContent = entry.message.content;
        let textContent: string | undefined;

        if (typeof msgContent === "string") {
          textContent = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              textContent = block.text;
              break;
            }
          }
        }

        if (textContent) {
          const metadata = extractSlashCommandMetadata(textContent);
          if (metadata) {
            slashCommandContext = metadata;
          }
        }
      }
    } catch {
      // Skip malformed
    }
  }

  // Add slash command context to result if found
  if (slashCommandContext) {
    collected.slashCommandContext = slashCommandContext;
  }

  // Second pass: scan backwards collecting messages until quotas met
  //
  // STALENESS LOGIC:
  // The maxStale parameter allows excluding messages that are "too old" relative
  // to the scan start (end of transcript). This prevents hooks from re-checking
  // user directives that were already processed in previous tool calls.
  //
  // Example with maxStale: 1:
  // - User sends directive at entry N
  // - AI makes tool call -> adds assistant entry N+1, tool_result entry N+2
  // - PreToolUse hook runs at N+2, scanDistance=1 for entry N+1, scanDistance=2 for entry N
  // - User directive at N has scanDistance=2 > maxStale=1, so it's EXCLUDED
  // - This prevents "AI ignored directive" false positives when AI already addressed it
  let scanDistance = 0;

  for (let i = allLines.length - 1; i >= 0; i--) {
    scanDistance++; // Track how far back we've scanned from the end

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
        // Check staleness: skip user messages beyond maxStale distance.
        // This prevents old user directives from being re-checked after they've
        // already been processed by previous hook invocations.
        const userStale = userSpec.maxStale !== undefined && scanDistance > userSpec.maxStale;
        const toolResultStale = toolResultSpec.maxStale !== undefined && scanDistance > toolResultSpec.maxStale;

        // Only process if at least one type is still collectible and not stale
        if (
          (!userStale && collected.user.length < targetUser) ||
          (!toolResultStale && collected.toolResult.length < targetToolResult)
        ) {
          processUserEntry(msgContent, i, collected, {
            // Pass 0 as target if stale to prevent collection
            targetUser: userStale ? 0 : targetUser,
            targetToolResult: toolResultStale ? 0 : targetToolResult,
            excludeSystemReminders,
            excludeSlashCommandPrompts,
            toolResultOptions,
            toolUseIdToName,
          });
        }
      } else if (role === 'assistant' && collected.assistant.length < targetAssistant) {
        // Check staleness for assistant messages
        const assistantStale = assistantSpec.maxStale !== undefined && scanDistance > assistantSpec.maxStale;
        if (!assistantStale) {
          const text = extractTextFromContent(msgContent);
          if (text) {
            collected.assistant.push({ role: 'assistant', content: text, index: i });
          }
        }
      }
    } catch {
      // Skip malformed
    }
  }

  // If includeFirstUserMessage is true, ensure we have the first user message
  if (includeFirstUserMessage && collected.user.length > 0) {
    const firstCollectedIndex = collected.user[0].index;

    // Only scan forward if first message might not be in our collection
    if (firstCollectedIndex > 0) {
      // Scan forward to find the first valid user message
      for (let i = 0; i < allLines.length; i++) {
        if (i >= firstCollectedIndex) break; // Stop at our earliest collected message

        try {
          const entry: TranscriptEntry = JSON.parse(allLines[i]);
          if (!entry.message || entry.message.role !== "user") continue;

          const msgContent = entry.message.content;
          let text: string | undefined;

          if (typeof msgContent === "string") {
            if (excludeSystemReminders && msgContent.startsWith("<system-reminder>")) continue;
            if (excludeSlashCommandPrompts && isSlashCommandPrompt(msgContent)) continue;
            text = msgContent;
          } else if (Array.isArray(msgContent)) {
            for (const block of msgContent) {
              if (block.type === "text" && block.text) {
                if (excludeSystemReminders && block.text.startsWith("<system-reminder>")) continue;
                if (excludeSlashCommandPrompts && isSlashCommandPrompt(block.text)) continue;
                text = block.text;
                break;
              }
            }
          }

          if (text) {
            // Found the first user message - prepend it if not already there
            const alreadyCollected = collected.user.some((m) => m.index === i);
            if (!alreadyCollected) {
              collected.user.unshift({ role: "user", content: text, index: i });
            }
            break;
          }
        } catch {
          // Skip malformed
        }
      }
    }
  }

  // Detect plan approval and inject synthetic user message
  if (detectPlanApproval) {
    const hasPlanApproval = collected.toolResult.some(
      (r) =>
        r.content.includes("ExitPlanMode") &&
        (r.content.includes("approved") || r.content.includes("allow"))
    );
    if (hasPlanApproval) {
      collected.user.push({
        role: "user",
        content: "I approved the plan. Proceed with implementation.",
        index: Infinity, // Sort to end
      });
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
      collected.user.push({ role: 'user', content: msgContent, index: lineIndex });
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

        // Filter out Claude Code's internal interruption messages.
        // When a user presses Escape to interrupt a tool call, Claude Code
        // injects messages like "STOP what you are doing" into the tool result.
        // Without this filter, hooks would misattribute these as user intent,
        // causing false positives like "User said STOP" when the user never
        // said that - Claude Code's interruption handler did.
        if (toolContent && isClaudeCodeInterruption(toolContent)) {
          continue;
        }

        if (trim && toolContent) {
          toolContent = trimToolOutput(toolContent, maxLines);
        }
        if (toolContent) {
          collected.toolResult.push({ role: 'tool_result', content: toolContent, index: lineIndex });
        }
      } else if (block.type === 'text' && block.text) {
        if (excludeSystemReminders && block.text.startsWith('<system-reminder>')) {
          continue;
        }
        if (excludeSlashCommandPrompts && isSlashCommandPrompt(block.text)) {
          continue;
        }
        if (collected.user.length < targetUser) {
          collected.user.push({ role: 'user', content: block.text, index: lineIndex });
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
