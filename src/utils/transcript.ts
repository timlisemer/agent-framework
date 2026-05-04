import * as fs from "fs";
import { stripQuotedAndPastedContent } from "./quote-detection.js";
import {
  detectAgentFrameworkWorkflowInvocation,
} from "./slash-commands.js";

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
export const CLAUDE_CODE_INTERRUPTION_PATTERNS = [
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
  role: 'user' | 'assistant' | 'tool';
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
  tool?: number | CountSpec;
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
  toolOptions?: {
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

  /** Exclude system-injected meta messages like stop-hook feedback (default: true) */
  excludeMetaMessages?: boolean;

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
  /** Tool messages */
  tool: TranscriptMessage[];
  /** Total messages collected across all types */
  totalCount: number;
  /** Slash command context if includeSlashCommandContext was true and a slash command was found */
  slashCommandContext?: SlashCommandContext;
  /**
   * True when the newest user-role entry in the transcript is a slash-command
   * invocation (`<command-name>/...</command-name>`). Populated independently
   * of `excludeSlashCommandPrompts` so callers can distinguish "no user
   * message" from "newest user message was a slash command and was filtered."
   */
  newestUserWasSlashCommand?: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  content?: string | ContentBlock[];
  tool_use_id?: string;
  name?: string; // Tool name for tool_use blocks
  id?: string; // Tool use ID for tool_use blocks
  is_error?: boolean; // tool_result error flag
}

interface TranscriptEntry {
  isMeta?: boolean;
  message?: {
    id?: string;
    role: string;
    content: string | ContentBlock[];
    stop_reason?: string;
  };
}

function normalizeCodexContentBlock(block: unknown): ContentBlock | null {
  if (!block || typeof block !== "object") return null;
  const input = block as Record<string, unknown>;
  const type = typeof input.type === "string" ? input.type : "";

  if (type === "input_text" || type === "output_text") {
    const text = typeof input.text === "string" ? input.text : "";
    return { type: "text", text };
  }

  if (type === "text" || type === "thinking" || type === "tool_use" || type === "tool_result") {
    return {
      type,
      text: typeof input.text === "string" ? input.text : undefined,
      content: typeof input.content === "string" || Array.isArray(input.content)
        ? input.content as string | ContentBlock[]
        : undefined,
      tool_use_id: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined,
      name: typeof input.name === "string" ? input.name : undefined,
      id: typeof input.id === "string" ? input.id : undefined,
      is_error: typeof input.is_error === "boolean" ? input.is_error : undefined,
    };
  }

  return null;
}

function normalizeCodexToolName(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  return `${namespace}${name}`;
}

function normalizeTranscriptEntry(raw: unknown): TranscriptEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as TranscriptEntry & { payload?: Record<string, unknown> };

  // Claude Code and scenario fixtures already use the canonical shape.
  if (entry.message) return entry;

  const payload = entry.payload;
  if (!payload || typeof payload !== "object") {
    return { isMeta: entry.isMeta };
  }

  if (payload.type === "message") {
    const role = typeof payload.role === "string" ? payload.role : "";
    if (role !== "user" && role !== "assistant") return { isMeta: entry.isMeta };

    const rawContent = payload.content;
    let content: string | ContentBlock[] = "";
    if (typeof rawContent === "string") {
      content = rawContent;
    } else if (Array.isArray(rawContent)) {
      content = rawContent
        .map(normalizeCodexContentBlock)
        .filter((block): block is ContentBlock => block !== null);
    }

    return {
      isMeta: entry.isMeta,
      message: {
        id: typeof payload.id === "string" ? payload.id : undefined,
        role,
        content,
      },
    };
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
    return {
      message: {
        id: typeof payload.id === "string" ? payload.id : callId,
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: callId,
            name: normalizeCodexToolName(payload),
          },
        ],
      },
    };
  }

  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    return {
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: typeof payload.call_id === "string" ? payload.call_id : undefined,
            content: typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? ""),
          },
        ],
      },
    };
  }

  return { isMeta: entry.isMeta };
}

function parseTranscriptEntry(line: string): TranscriptEntry | null {
  try {
    return normalizeTranscriptEntry(JSON.parse(line));
  } catch {
    return null;
  }
}

/**
 * One logical assistant API message, which Claude Code may split across
 * multiple jsonl lines sharing the same `message.id`. Under load those
 * sibling lines can be flushed to disk out of stream order (e.g. tool_use
 * before text), so the scanner must treat them as one unit.
 */
interface AssistantGroup {
  msgId: string;
  indices: number[];
  lastIndex: number;
  text: string;
  hasThinking: boolean;
  hasToolUse: boolean;
  toolUseIds: string[];
  entryCount: number;
}

/**
 * Build a map from jsonl index -> AssistantGroup. Consecutive assistant
 * entries sharing a message.id collapse into one group; assistants without
 * an id each form a singleton group keyed by their index.
 */
function buildAssistantGroups(
  parsedEntries: (TranscriptEntry | null)[]
): Map<number, AssistantGroup> {
  const byMsgId = new Map<string, AssistantGroup>();
  const byIndex = new Map<number, AssistantGroup>();

  for (let i = 0; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message || entry.message.role !== "assistant") continue;

    const msgId = entry.message.id ?? `__singleton_${i}`;
    let group = byMsgId.get(msgId);
    if (!group) {
      group = {
        msgId,
        indices: [],
        lastIndex: i,
        text: "",
        hasThinking: false,
        hasToolUse: false,
        toolUseIds: [],
        entryCount: 0,
      };
      byMsgId.set(msgId, group);
    }

    group.indices.push(i);
    group.entryCount++;
    if (i > group.lastIndex) group.lastIndex = i;

    const content = entry.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          group.text = group.text ? `${group.text} ${block.text}` : block.text;
        } else if (block.type === "thinking") {
          group.hasThinking = true;
        } else if (block.type === "tool_use") {
          group.hasToolUse = true;
          if (block.id) group.toolUseIds.push(block.id);
        }
      }
    } else if (typeof content === "string" && content) {
      group.text = group.text ? `${group.text} ${content}` : content;
    }

    byIndex.set(i, group);
  }

  return byIndex;
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
 * Detect if content is a workflow invocation message.
 * Claude Code wraps slash commands in <command-name> tags. Codex exposes
 * command-equivalent workflows as explicit $agent-framework-* skill mentions.
 */
function isSlashCommandPrompt(content: string): boolean {
  return detectAgentFrameworkWorkflowInvocation(content) !== null;
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
  // Live path: Claude Code strips YAML frontmatter when materializing the
  // slash-command body into the jsonl. The invocation tag
  // <command-name>/NAME</command-name> appears on a separate user entry
  // WITHOUT frontmatter. Detect the tag and resolve allowed-tools from
  // the command file on disk.
  const invocation = detectAgentFrameworkWorkflowInvocation(content);
  if (invocation) {
    return {
      commandName: invocation.commandName,
      allowedTools: [...invocation.allowedTools],
    };
  }

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
 * Validate a transcript configuration for logical consistency.
 *
 * The key validation rule: For any message type with `maxStale` set,
 * the sum of OTHER message type counts must be >= maxStale.
 *
 * This ensures that if we exclude stale messages of type X, we have enough
 * context from other message types to determine if they were addressed.
 *
 * Example:
 * - `user: { count: 3, maxStale: 5 }` requires `assistant.count + tool.count >= 5`
 * - If user messages beyond 5 lines are excluded, we need 5 lines of context
 *
 * @param config - The transcript read options to validate
 * @param configName - Name of the config (for error messages)
 * @throws Error if validation fails
 */
export function validateTranscriptConfig(
  config: TranscriptReadOptions,
  configName: string
): void {
  const userSpec = normalizeCount(config.counts.user);
  const assistantSpec = normalizeCount(config.counts.assistant);
  const toolSpec = normalizeCount(config.counts.tool);

  // Validate user maxStale: need enough assistant + tool context
  if (userSpec.maxStale !== undefined) {
    const contextCount = assistantSpec.count + toolSpec.count;
    if (contextCount < userSpec.maxStale) {
      throw new Error(
        `TranscriptConfig "${configName}" invalid:\n` +
        `  user.maxStale (${userSpec.maxStale}) > assistant.count + tool.count (${contextCount})\n` +
        `  Stale user messages will be excluded but there's not enough context\n` +
        `  to determine if they were addressed. Increase assistant or tool counts.`
      );
    }
  }

  // Validate assistant maxStale: need enough user + tool context
  if (assistantSpec.maxStale !== undefined) {
    const contextCount = userSpec.count + toolSpec.count;
    if (typeof userSpec.count === "number" && contextCount < assistantSpec.maxStale) {
      throw new Error(
        `TranscriptConfig "${configName}" invalid:\n` +
        `  assistant.maxStale (${assistantSpec.maxStale}) > user.count + tool.count (${contextCount})\n` +
        `  Stale assistant messages will be excluded but there's not enough context.`
      );
    }
  }

  // Validate tool maxStale: need enough user + assistant context
  if (toolSpec.maxStale !== undefined) {
    const userCount = typeof userSpec.count === "number" ? userSpec.count : 0;
    const contextCount = userCount + assistantSpec.count;
    if (contextCount < toolSpec.maxStale) {
      throw new Error(
        `TranscriptConfig "${configName}" invalid:\n` +
        `  tool.maxStale (${toolSpec.maxStale}) > user.count + assistant.count (${contextCount})\n` +
        `  Stale tool results will be excluded but there's not enough context.`
      );
    }
  }
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
 *   counts: { user: 5, assistant: 5, tool: 3 },
 *   toolOptions: { trim: true, maxLines: 20 }
 * });
 */
export async function readTranscriptExact(
  transcriptPath: string,
  options: TranscriptReadOptions
): Promise<TranscriptReadResult> {
  const {
    counts,
    toolOptions = {},
    excludeSystemReminders = true,
    excludeSlashCommandPrompts = false,
    excludeMetaMessages = true,
    includeFirstUserMessage = false,
    includeSlashCommandContext = false,
  } = options;

  // Normalize count specs to handle both simple numbers and CountSpec objects.
  // This enables backward compatibility: `user: 3` works alongside `user: { count: 1, maxStale: 1 }`.
  const userSpec = normalizeCount(counts.user);
  const assistantSpec = normalizeCount(counts.assistant);
  const toolSpec = normalizeCount(counts.tool);

  const targetUser = userSpec.count;
  const targetAssistant = assistantSpec.count;
  const targetTool = toolSpec.count;

  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");

  const collected: TranscriptReadResult = {
    user: [],
    assistant: [],
    tool: [],
    totalCount: 0,
  };

  // Map tool_use_id -> tool_name for filtering tool_results
  const toolUseIdToName = new Map<string, string>();

  // Track slash command context if requested (scan backwards, use most recent)
  let slashCommandContext: SlashCommandContext | undefined;

  // Parse all lines once upfront to avoid triple-parsing (performance optimization)
  const parsedEntries: (TranscriptEntry | null)[] = allLines.map(parseTranscriptEntry);

  // Group assistant entries by message.id — Claude Code splits one logical
  // API message across multiple jsonl lines, one per content block, and can
  // flush them out of order. The backward scan consumes groups, not lines.
  const assistantGroupByIndex = buildAssistantGroups(parsedEntries);

  // First pass: build tool_use ID map from entire file
  // Also extract slash command context if requested
  for (const entry of parsedEntries) {
    if (!entry) continue;

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

  // Hard boundary for assistant collection: once we push the most recent user
  // message, any assistant entry at a lower index belongs to a previous turn
  // and must not be reported as `lastAssistant`. The backward scan is
  // otherwise happy to hand back a prior-turn assistant when the current
  // turn's entries are not yet in the transcript (Claude Code can fire
  // PreToolUse hooks before all of this turn's assistant content blocks have
  // been written). Reporting a prior-turn assistant under a fresh user is a
  // category error — the two are unrelated. `firstUserSeenIndex` prevents it.
  let firstUserSeenIndex: number | null = null;
  const userLenBeforeIter = () => collected.user.length;

  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    scanDistance++; // Track how far back we've scanned from the end

    // Early exit if all quotas met
    if (
      collected.user.length >= targetUser &&
      collected.assistant.length >= targetAssistant &&
      collected.tool.length >= targetTool
    ) {
      break;
    }

    const entry = parsedEntries[i];
    if (!entry) continue;

    if (!entry.message) continue;

    const { role, content: msgContent } = entry.message;

    if (role === 'user') {
      // Skip system-injected meta messages (stop-hook feedback, slash command
      // instruction bodies). These are not real user input and must not
      // count as "the newest user entry" for any downstream flag.
      if (excludeMetaMessages && entry.isMeta === true) {
        continue;
      }

      // Detect whether the newest REAL user-role entry is a slash-command
      // invocation. Callers (e.g. respond-first) use this to distinguish
      // "no user message" from "newest was filtered by excludeSlashCommandPrompts."
      // Computed after meta-skip so a slash-command body entry written by
      // Claude Code with isMeta=true does not shadow the actual
      // <command-name>/.../</command-name> invocation entry.
      if (collected.newestUserWasSlashCommand === undefined) {
        let probe: string | undefined;
        if (typeof msgContent === 'string') {
          probe = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === 'text' && block.text) {
              probe = block.text;
              break;
            }
          }
        }
        if (probe !== undefined) {
          collected.newestUserWasSlashCommand = isSlashCommandPrompt(probe);
        }
      }

      // Check staleness: skip user messages beyond maxStale distance.
      // This prevents old user directives from being re-checked after they've
      // already been processed by previous hook invocations.
      const userStale = userSpec.maxStale !== undefined && scanDistance > userSpec.maxStale;
      const toolStale = toolSpec.maxStale !== undefined && scanDistance > toolSpec.maxStale;

      // Only process if at least one type is still collectible and not stale
      if (
        (!userStale && collected.user.length < targetUser) ||
        (!toolStale && collected.tool.length < targetTool)
      ) {
        const beforeLen = userLenBeforeIter();
        processUserEntry(msgContent, i, collected, {
          // Pass 0 as target if stale to prevent collection
          targetUser: userStale ? 0 : targetUser,
          targetTool: toolStale ? 0 : targetTool,
          excludeSystemReminders,
          excludeSlashCommandPrompts,
          toolOptions,
          toolUseIdToName,
        });
        // If processUserEntry actually pushed a user message, record the
        // first (most recent, since we scan backward) user index we've seen.
        if (firstUserSeenIndex === null && collected.user.length > beforeLen) {
          firstUserSeenIndex = i;
        }
      }
    } else if (role === 'assistant' && collected.assistant.length < targetAssistant) {
      const group = assistantGroupByIndex.get(i);
      if (!group) continue;
      // Process each group exactly once — on its highest index, which is the
      // first index we hit scanning backward.
      if (i !== group.lastIndex) continue;
      // Hard boundary: the whole group is "previous turn" only if its latest
      // line sits before the most recent user entry.
      if (firstUserSeenIndex !== null && group.lastIndex < firstUserSeenIndex) {
        continue;
      }
      const assistantStale = assistantSpec.maxStale !== undefined && scanDistance > assistantSpec.maxStale;
      if (!assistantStale && group.text) {
        collected.assistant.push({ role: 'assistant', content: group.text, index: group.lastIndex });
      }
    }
  }

  // If includeFirstUserMessage is true, ensure we have the first user message
  if (includeFirstUserMessage && collected.user.length > 0) {
    const firstCollectedIndex = collected.user[0].index;

    // Only scan forward if first message might not be in our collection
    if (firstCollectedIndex > 0) {
      // Scan forward to find the first valid user message (using pre-parsed entries)
      for (let i = 0; i < parsedEntries.length; i++) {
        if (i >= firstCollectedIndex) break; // Stop at our earliest collected message

        const entry = parsedEntries[i];
        if (!entry || !entry.message || entry.message.role !== "user") continue;
        if (excludeMetaMessages && entry.isMeta === true) continue;

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
      }
    }
  }

  collected.totalCount =
    collected.user.length + collected.assistant.length + collected.tool.length;

  return collected;
}

export type CurrentTurnAssistantState =
  | { kind: "no-current-turn" }
  | { kind: "responded"; text: string; toolUseIds: string[] }
  | { kind: "silent"; toolUseIds: string[] };

/**
 * Answer "has the current turn's assistant responded with text?" for a
 * PreToolUse hook, collapsing all `message.id` grouping concerns inside
 * this utility. Downstream rules MUST NOT reason about msg_id, multi-line
 * flush, or sibling entry counts.
 *
 * Internally, `buildAssistantGroups` collapses jsonl lines sharing a
 * `message.id` into one logical group. The group's text is the
 * concatenation of every text block across all sibling lines. Callers get
 * one of three states:
 *
 * - `no-current-turn`: no non-meta user entry precedes the firing
 *   assistant turn (nothing to respond to).
 * - `responded`: the current-turn group contains at least one text block.
 * - `silent`: the current-turn group has no text block at hook-fire time.
 *   This is the single "no-text" state, whether the group is a single
 *   jsonl line or a multi-line `assistant_split`.
 */
export async function currentTurnAssistantState(
  transcriptPath: string,
  firingToolUseId?: string
): Promise<CurrentTurnAssistantState> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");
  const parsedEntries: (TranscriptEntry | null)[] = allLines.map(parseTranscriptEntry);

  // Find the last non-meta user entry.
  let lastUserIndex = -1;
  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;
    lastUserIndex = i;
    break;
  }
  if (lastUserIndex === -1) {
    return { kind: "no-current-turn" };
  }

  const groups = buildAssistantGroups(parsedEntries);

  // Select the current-turn group: the one whose lastIndex is the highest
  // value still greater than lastUserIndex. If none, fall back to the group
  // containing the firing tool_use_id (must also be after the user).
  let current: AssistantGroup | undefined;
  const seen = new Set<AssistantGroup>();
  for (const group of groups.values()) {
    if (seen.has(group)) continue;
    seen.add(group);
    if (group.lastIndex <= lastUserIndex) continue;
    if (!current || group.lastIndex > current.lastIndex) current = group;
  }
  if (!current && firingToolUseId) {
    for (const group of groups.values()) {
      if (group.toolUseIds.includes(firingToolUseId) && group.lastIndex > lastUserIndex) {
        current = group;
        break;
      }
    }
  }
  if (!current) {
    return { kind: "no-current-turn" };
  }

  if (current.text.length > 0) {
    return { kind: "responded", text: current.text, toolUseIds: current.toolUseIds };
  }
  return { kind: "silent", toolUseIds: current.toolUseIds };
}

/**
 * Returns true iff the most recent non-meta user-text entry in the transcript
 * has no `tool_result` block following it (in any later entry, regardless of
 * role). Caller MUST gate on state.forceCheckPending===true.
 *
 * Mirrors the live UserPromptSubmit semantic: any fresh user prompt
 * supersedes the workaround lockout. The PreToolUse-side fallback exists
 * because the test harness fires only SessionStart + the target hook for a
 * PreToolUse target (UserPromptSubmit is not invoked), and live sessions
 * can compact the originating errored tool_result out of the visible window.
 *
 * Transcript-shape invariants this helper relies on:
 * - Live Claude Code emits each tool_result as a separate user-role entry
 *   AFTER the assistant tool_use that produced it.
 * - The test harness (buildAllTranscriptLines) preserves tool_result blocks
 *   INSIDE the assistant entry's content array.
 * Both shapes are handled identically because we scan all entries forward
 * from userIdx+1 for any tool_result block irrespective of role.
 *
 * Mid-turn retry semantics: when the assistant retries within the same user
 * turn (assistant tool_use → tool_result error → assistant retry tool_use),
 * a tool_result block sits between the user-text entry and the firing
 * assistant entry, so the helper returns false and the lockout persists.
 * Cross-turn after fresh user input: no completed tool work yet → returns
 * true → lockout clears.
 */
export async function userTurnIsFreshSinceLockout(
  transcriptPath: string,
): Promise<boolean> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");
  const parsedEntries: (TranscriptEntry | null)[] = allLines.map(parseTranscriptEntry);

  let userIdx = -1;
  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message) continue;
    if (entry.message.role !== "user" || entry.isMeta === true) continue;
    const blocks = entry.message.content;
    const hasText =
      typeof blocks === "string"
        ? blocks.length > 0
        : Array.isArray(blocks) &&
          blocks.some((b) => b && b.type === "text" && (b.text ?? "").length > 0);
    if (hasText) {
      userIdx = i;
      break;
    }
  }

  if (userIdx < 0) return false;

  for (let i = userIdx + 1; i < parsedEntries.length; i++) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message) continue;
    const blocks = entry.message.content;
    if (!Array.isArray(blocks)) continue;
    if (blocks.some((b) => b && b.type === "tool_result")) {
      return false;
    }
  }

  return true;
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
    targetTool: number;
    excludeSystemReminders: boolean;
    excludeSlashCommandPrompts: boolean;
    toolOptions: TranscriptReadOptions['toolOptions'];
    toolUseIdToName: Map<string, string>;
  }
): void {
  const {
    targetUser,
    targetTool,
    excludeSystemReminders,
    excludeSlashCommandPrompts,
    toolOptions,
    toolUseIdToName,
  } = config;
  const { trim = false, maxLines = 20, excludeToolNames = [] } = toolOptions ?? {};

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
      if (block.type === 'tool_result' && collected.tool.length < targetTool) {
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
          const toolName = block.tool_use_id ? toolUseIdToName.get(block.tool_use_id) : undefined;
          const prefix = toolName ? `[${toolName}] ` : "";
          collected.tool.push({ role: 'tool', content: `${prefix}${toolContent}`, index: lineIndex });
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
    ...result.tool.map((m) => ({ ...m, prefix: 'TOOL' })),
  ].sort((a, b) => a.index - b.index);

  return allMessages.map((m) => `${m.prefix}: ${m.content}`).join('\n\n');
}

/**
 * Minimum transcript requirements for agent processing.
 */
export interface MinimumTranscriptRequirements {
  /** Minimum user messages required (default: 0) */
  user?: number;
  /** Minimum assistant messages required (default: 0) */
  assistant?: number;
  /** Minimum tool messages required (default: 0) */
  tool?: number;
  /**
   * If true, require at least one of assistant OR tool.
   * Useful for error-acknowledge which needs context but either type is sufficient.
   */
  assistantOrTool?: number;
}

/**
 * Check if transcript meets minimum requirements for agent processing.
 *
 * Agents can skip LLM calls if transcript is empty or has insufficient context.
 * This is a fast-path optimization to avoid wasting LLM calls when there's
 * nothing meaningful to analyze.
 *
 * @param result - The transcript read result
 * @param requirements - Minimum counts needed for each message type
 * @returns true if transcript meets ALL requirements, false to skip LLM
 *
 * @example
 * // Error-acknowledge needs user message AND some context (assistant or tool result)
 * if (!hasMinimumTranscript(result, { user: 1, assistantOrTool: 1 })) {
 *   return "OK"; // Skip LLM, nothing to check
 * }
 *
 * @example
 * // Style-drift only needs user messages to check for style requests
 * if (!hasMinimumTranscript(result, { user: 1 })) {
 *   return "OK"; // Skip LLM, no user context
 * }
 */
export function hasMinimumTranscript(
  result: TranscriptReadResult,
  requirements: MinimumTranscriptRequirements
): boolean {
  const { user = 0, assistant = 0, tool = 0, assistantOrTool } = requirements;

  // Check individual requirements
  if (result.user.length < user) return false;
  if (result.assistant.length < assistant) return false;
  if (result.tool.length < tool) return false;

  // Check combined assistant OR tool requirement
  if (assistantOrTool !== undefined) {
    const combined = result.assistant.length + result.tool.length;
    if (combined < assistantOrTool) return false;
  }

  return true;
}

/**
 * Read the last N real user text messages from a transcript JSONL, oldest
 * first, separated by `---`. Filters out tool_result blocks, system reminders,
 * slash command prompts, and meta entries. Each message has
 * `stripQuotedAndPastedContent` applied so the SENTIMENT_AGENT sees the user's
 * own words, not pasted CLI output.
 *
 * Returns an empty string when the file can't be read.
 */
export async function readRecentUserMessages(
  transcriptPath: string,
  n: number,
  withIndices: boolean = false,
): Promise<string> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return "";
  }
  const lines = raw.trim().split("\n");
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < n; i--) {
    const entry = parseTranscriptEntry(lines[i]);
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;

    const content = entry.message.content;
    let text: string | undefined;
    if (typeof content === "string") {
      if (content.startsWith("<system-reminder>")) continue;
      if (isSlashCommandPrompt(content)) continue;
      text = content;
    } else if (Array.isArray(content)) {
      // Skip entries that are pure tool_result; collect first text block.
      let foundText: string | undefined;
      let onlyToolResults = true;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (block.text.startsWith("<system-reminder>")) continue;
          if (isSlashCommandPrompt(block.text)) continue;
          foundText = block.text;
          onlyToolResults = false;
          break;
        }
        if (block.type !== "tool_result") onlyToolResults = false;
      }
      if (onlyToolResults) continue;
      text = foundText;
    }
    if (!text) continue;
    const stripped = stripQuotedAndPastedContent(text);
    if (!stripped.trim()) continue;
    collected.push(stripped);
  }
  // Reverse so oldest is first for display.
  const reversed = collected.reverse();
  const total = reversed.length;
  return withIndices
    ? reversed.map((msg, i) => `[T${total - 1 - i}] ${msg}`).join("\n---\n")
    : reversed.join("\n---\n");
}

/**
 * Array-returning sibling of `readRecentUserMessages`. Returns up to `n` real
 * user-text messages from the transcript, OLDEST-FIRST, with the same
 * filtering rules: skips meta entries, slash-command prompts,
 * `<system-reminder>` prefixes, and pure tool_result entries; applies
 * `stripQuotedAndPastedContent` to each. Used by callers (e.g.
 * pre-tool-use's RuleContext build) that need a structural array and would
 * otherwise have to roundtrip through `\n---\n` string-split — which would
 * fragment user messages containing literal `---` separators.
 *
 * Returns `[]` on read error.
 */
export async function readRecentUserMessagesArray(
  transcriptPath: string,
  n: number,
): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.trim().split("\n");
  const collected: string[] = [];
  for (let i = lines.length - 1; i >= 0 && collected.length < n; i--) {
    const entry = parseTranscriptEntry(lines[i]);
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;

    const content = entry.message.content;
    let text: string | undefined;
    if (typeof content === "string") {
      if (content.startsWith("<system-reminder>")) continue;
      if (isSlashCommandPrompt(content)) continue;
      text = content;
    } else if (Array.isArray(content)) {
      let foundText: string | undefined;
      let onlyToolResults = true;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (block.text.startsWith("<system-reminder>")) continue;
          if (isSlashCommandPrompt(block.text)) continue;
          foundText = block.text;
          onlyToolResults = false;
          break;
        }
        if (block.type !== "tool_result") onlyToolResults = false;
      }
      if (onlyToolResults) continue;
      text = foundText;
    }
    if (!text) continue;
    const stripped = stripQuotedAndPastedContent(text);
    if (!stripped.trim()) continue;
    collected.push(stripped);
  }
  return collected.reverse();
}

/**
 * Determine whether the user-text turn whose RAW (un-stripped) first text
 * block startsWith `snippet.trim()` has been followed in the transcript by
 * at least one COMPLETED non-error assistant tool round-trip (assistant
 * `tool_use` followed by a user `tool_result` whose `is_error !== true`
 * and whose content is not a Claude Code interruption marker).
 *
 * Used by decidePrediction step 3.10 (discharged-side-clarification
 * fallback) to recognize when the cached prediction's source user turn
 * has effectively been "consumed" by an intervening tool round-trip
 * obeying its imperative.
 *
 * The cached `userMessageSnippet` is stored RAW by user-prompt-submit
 * (`input.prompt.slice(0, 200)` — no stripQuotedAndPastedContent pass), so
 * we compare against the raw transcript text here. Anchors on the LAST
 * occurrence so a coincidentally repeating phrase doesn't trigger on a
 * stale earlier match.
 *
 * Returns false on read error or when no anchor / no completed roundtrip
 * found after the anchor.
 */
export async function userTurnFollowedByCompletedToolRoundtrip(
  transcriptPath: string,
  snippet: string,
): Promise<boolean> {
  const trimmed = snippet.trim();
  if (!trimmed) return false;
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return false;
  }
  const lines = raw.trim().split("\n");
  const parsed: (TranscriptEntry | null)[] = lines.map(parseTranscriptEntry);

  // Locate the LAST non-meta user-text entry whose RAW first text block
  // startsWith `trimmed`.
  let anchorIndex = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const entry = parsed[i];
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;
    const content = entry.message.content;
    let firstText: string | undefined;
    if (typeof content === "string") {
      if (content.startsWith("<system-reminder>")) continue;
      if (isSlashCommandPrompt(content)) continue;
      firstText = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (block.text.startsWith("<system-reminder>")) continue;
          if (isSlashCommandPrompt(block.text)) continue;
          firstText = block.text;
          break;
        }
      }
    }
    if (!firstText) continue;
    if (firstText.startsWith(trimmed)) {
      anchorIndex = i;
      break;
    }
  }
  if (anchorIndex < 0) return false;

  // Build a map from assistant tool_use_id to its line index, for tool_use
  // entries that appear strictly AFTER the anchor.
  const toolUseIndex = new Map<string, number>();
  for (let i = anchorIndex + 1; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || !entry.message || entry.message.role !== "assistant") continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === "tool_use" && block.id) {
        toolUseIndex.set(block.id, i);
      }
    }
  }

  // Scan forward of anchor for any user entry containing a non-error,
  // non-interruption tool_result whose tool_use_id resolves to an
  // assistant tool_use strictly between anchor and this entry.
  for (let i = anchorIndex + 1; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      if (block.is_error === true) continue;
      const useId = block.tool_use_id;
      if (!useId) continue;
      const useLine = toolUseIndex.get(useId);
      if (useLine === undefined || useLine <= anchorIndex || useLine >= i) continue;
      // Stringify content for interruption check.
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === "text" && inner.text) text += inner.text;
        }
      }
      if (text && isClaudeCodeInterruption(text)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Resolve the active slash-command workflow's authorized tool list.
 *
 * Backward-scans the transcript for the most recent user entry containing
 * <command-name>/NAME</command-name>. Returns the SLASH_COMMAND_ALLOWED_TOOLS
 * entry for that command, or undefined if no tag is found or the command
 * has no entry.
 *
 * The slash-command tag persists across the multi-step workflow (steps 1-5
 * of /plan3 share one tag). A subsequent non-tag user turn does NOT retract
 * the workflow — only a NEW <command-name>/X</command-name> tag (which then
 * becomes the most recent and shadows the previous one) does.
 */
export async function resolveActiveSlashCommandAllowedTools(
  transcriptPath: string,
): Promise<readonly string[] | undefined> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return undefined;
  }
  const lines = raw.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseTranscriptEntry(lines[i]);
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;

    const content = entry.message.content;
    let text: string | undefined;
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          text = block.text;
          break;
        }
      }
    }
    if (!text) continue;
    if (!isSlashCommandPrompt(text)) continue;

    const metadata = extractSlashCommandMetadata(text);
    if (metadata?.allowedTools && metadata.allowedTools.length > 0) {
      return metadata.allowedTools;
    }
  }
  return undefined;
}

export interface ParallelBatchInfo {
  /** Position of this tool in the batch (0 = leader, 1+ = sibling) */
  position: number;
  /** Total tools in this batch */
  batchSize: number;
  /** tool_use_id of the leader (position 0) */
  leaderId: string;
  /** All tool_use_ids in the batch, in transcript order */
  allIds: string[];
}

/**
 * Detect if a tool_use_id belongs to a parallel batch.
 *
 * Scans backwards from end of transcript for consecutive assistant entries
 * with tool_use blocks, skipping non-message metadata entries. Returns null
 * for solo tool calls (batch size 1).
 */
export async function detectParallelBatch(
  transcriptPath: string,
  toolUseId: string,
): Promise<ParallelBatchInfo | null> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");

  const parsed: (TranscriptEntry | null)[] = lines.map(parseTranscriptEntry);

  // Collect all assistant tool_use entries with their line indices and tool_use_ids
  interface ToolUseEntry {
    lineIndex: number;
    toolUseId: string;
    toolName: string;
  }
  const toolUseEntries: ToolUseEntry[] = [];

  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    if (!entry) continue;
    const message = entry.message;
    if (!message || message.role !== "assistant") continue;
    const entryContent = message.content;
    if (!Array.isArray(entryContent)) continue;
    for (const block of entryContent) {
      if (block.type === "tool_use" && block.id) {
        toolUseEntries.push({
          lineIndex: i,
          toolUseId: block.id,
          toolName: block.name ?? "",
        });
      }
    }
  }

  // Find the line containing the target toolUseId
  const targetEntry = toolUseEntries.find((e) => e.toolUseId === toolUseId);

  // Helper: check if a line is an assistant tool_use line
  function isAssistantToolUseLine(lineIdx: number): boolean {
    return toolUseEntries.some((e) => e.lineIndex === lineIdx);
  }

  // Helper: check if a line is a non-message metadata line (skip type)
  function isNonMessageLine(lineIdx: number): boolean {
    const entry = parsed[lineIdx];
    if (!entry) return false;
    return !entry.message;
  }

  // Helper: check if a line is an assistant thinking-only line
  function isThinkingOnlyLine(lineIdx: number): boolean {
    const entry = parsed[lineIdx];
    if (!entry) return false;
    const message = entry.message;
    if (!message || message.role !== "assistant") return false;
    const entryContent = message.content;
    if (!Array.isArray(entryContent)) return false;
    const hasToolUse = entryContent.some((b) => b.type === "tool_use");
    const hasText = entryContent.some((b) => b.type === "text" && (b.text ?? "").length > 0);
    if (hasToolUse || hasText) return false;
    const hasThinking = entryContent.some((b) => b.type === "thinking");
    return hasThinking;
  }

  // Collect batch line indices.
  const batchLineIndices = new Set<number>();

  if (targetEntry) {
    // Standard path: the firing tool_use_id is on disk. Walk backward and
    // forward from its line, collecting consecutive assistant tool_use lines.
    batchLineIndices.add(targetEntry.lineIndex);

    for (let i = targetEntry.lineIndex - 1; i >= 0; i--) {
      if (isNonMessageLine(i) || isThinkingOnlyLine(i)) continue;
      if (isAssistantToolUseLine(i)) {
        batchLineIndices.add(i);
        continue;
      }
      break; // user/tool_result or text-only assistant
    }

    for (let i = targetEntry.lineIndex + 1; i < parsed.length; i++) {
      if (isNonMessageLine(i) || isThinkingOnlyLine(i)) continue;
      if (isAssistantToolUseLine(i)) {
        batchLineIndices.add(i);
        continue;
      }
      break;
    }
  } else {
    // Live race fallback: the firing tool_use_id has not been flushed to
    // jsonl yet. Real Claude Code can fire a sibling's PreToolUse hook
    // before that sibling's line lands on disk, so the standard lookup
    // returns no match. Detect retroactively by collecting the trailing
    // run of consecutive assistant tool_use lines at the very end of the
    // transcript — if such a run exists with no user/tool_result entry
    // following it, treat the firing call as the next sibling of that
    // in-flight batch. The firing id is appended to allIds below.
    for (let i = parsed.length - 1; i >= 0; i--) {
      if (isNonMessageLine(i) || isThinkingOnlyLine(i)) continue;
      if (isAssistantToolUseLine(i)) {
        batchLineIndices.add(i);
        continue;
      }
      break;
    }
    if (batchLineIndices.size === 0) return null;
  }

  // Collect all tool_use_ids from batch lines, sorted by line index
  const sortedLineIndices = Array.from(batchLineIndices).sort((a, b) => a - b);
  const batchIds: string[] = [];
  for (const lineIdx of sortedLineIndices) {
    for (const entry of toolUseEntries) {
      if (entry.lineIndex === lineIdx) {
        batchIds.push(entry.toolUseId);
      }
    }
  }

  // Race fallback: append the firing id as the trailing sibling so that
  // findBatchDecision's allIds set covers it and pre-tool-use.ts treats it
  // as a sibling (position > 0) rather than the leader.
  if (!targetEntry) {
    batchIds.push(toolUseId);
  }

  if (batchIds.length < 2) return null;

  const position = batchIds.indexOf(toolUseId);
  return {
    position,
    batchSize: batchIds.length,
    leaderId: batchIds[0],
    allIds: batchIds,
  };
}

/**
 * Find the most recent message by transcript index.
 * readTranscriptExact scans backwards, so array order doesn't match chronological order.
 */
export function getMostRecentMessage(messages: TranscriptMessage[]): TranscriptMessage {
  return messages.reduce((latest, msg) =>
    msg.index > latest.index ? msg : latest
  );
}
