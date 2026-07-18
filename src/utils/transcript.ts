import * as fs from "fs";
import { stripQuotedAndPastedContent } from "./quote-detection.js";
import { activeSpec } from "../adapter/spec.js";
import {
  SLASH_COMMAND_ALLOWED_TOOLS,
} from "./slash-commands.js";
import type { AdapterSpec, ContentBlock } from "../adapter/types.js";
import type { PriorErrorContext, PriorErrorSource } from "./prior-error-context.js";
import {
  buildAssistantGroups,
  collectAssistantTextCandidates,
  parseActiveTranscriptLines,
  userEntryHasHumanText,
  type AssistantGroup,
} from "./canonical-transcript.js";

export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  index: number;
}

export interface TranscriptToolResultMessage extends TranscriptMessage {
  role: "tool";
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Count specification for a message type.
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
 */
export interface MessageCounts {
  user?: CountSpec;
  assistant?: CountSpec;
  tool?: CountSpec;
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
  tool: TranscriptToolResultMessage[];
  /** Total messages collected across all types */
  totalCount: number;
  /** Slash command context if includeSlashCommandContext was true and a slash command was found */
  slashCommandContext?: SlashCommandContext;
  /**
   * True when the newest user-role entry in the transcript is a workflow
   * invocation. Populated independently of `excludeSlashCommandPrompts` so
   * callers can distinguish "no user message" from "newest user message was
   * a slash command and was filtered."
   */
  newestUserWasSlashCommand?: boolean;
  /**
   * Newest raw assistant text blocks from the same parsed transcript snapshot,
   * before adjacent assistant entries are grouped for rule context.
   */
  assistantTextCandidates?: string[];
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
 * Delegates to the active adapter to recognize adapter-specific syntax.
 */
function isSlashCommandPrompt(content: string, spec: AdapterSpec = activeSpec()): boolean {
  return spec.recognizeWorkflowInvocation(content) !== null;
}

function isWorkflowInvocationOnlyPrompt(content: string, spec: AdapterSpec = activeSpec()): boolean {
  return spec.isWorkflowInvocationOnly(content);
}


/**
 * Extract slash command metadata from a slash command system prompt.
 * Returns null if the content is not a slash command prompt.
 *
 * Detects workflow invocations via the active adapter and resolves
 * the allowed tools from the canonical SLASH_COMMAND_ALLOWED_TOOLS table.
 * Also parses YAML frontmatter for description and allowed-tools fields.
 */
function extractSlashCommandMetadata(
  content: string,
  spec: AdapterSpec = activeSpec(),
): SlashCommandContext | null {
  // Live path: detect workflow invocation via active adapter
  const canonical = spec.recognizeWorkflowInvocation(content);
  if (canonical) {
    const allowedTools = SLASH_COMMAND_ALLOWED_TOOLS[canonical];
    return {
      commandName: canonical,
      allowedTools: allowedTools ? [...allowedTools] : [],
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
    const rawTools = toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
    // Resolve any wire-name tools to canonical names
    const resolvedTools: string[] = [];
    for (const tool of rawTools) {
      const mcp = spec.recognizeMcp(tool);
      if (mcp) {
        resolvedTools.push(`mcp-${mcp}`);
      } else {
        resolvedTools.push(tool);
      }
    }
    allowedTools = resolvedTools;

    // Infer command name from allowed-tools: look for mcp-<command> pattern
    for (const tool of resolvedTools) {
      const mcpMatch = tool.match(/^mcp-(\w+)$/);
      if (mcpMatch) {
        const canonicalCheck = spec.recognizeMcp(
          spec.mcpWireName(mcpMatch[1] as import("../adapter/types.js").CanonicalMcp)
        );
        if (canonicalCheck) {
          commandName = canonicalCheck;
          break;
        }
      }
    }

    // Also try direct canonical match
    if (!commandName) {
      for (const tool of resolvedTools) {
        const canonicalWorkflow = Object.keys(SLASH_COMMAND_ALLOWED_TOOLS).find(
          (k) => SLASH_COMMAND_ALLOWED_TOOLS[k as import("./slash-commands.js").SlashCommandWorkflow]?.includes(tool)
        );
        if (canonicalWorkflow) {
          commandName = canonicalWorkflow;
          break;
        }
      }
    }
  }

  // Fallback: try to infer from description
  if (!commandName && description) {
    const cmdMatch = description.match(/\b(commit|push|fullconfirm|confirm|check)\b/i);
    if (cmdMatch) {
      commandName = cmdMatch[1].toLowerCase();
    }
  }

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

function classifyActionableToolResult(message: TranscriptToolResultMessage): PriorErrorSource | null {
  const text = message.content;
  const tool = message.toolName ?? "";

  if (/\[AUTOGENERATED STOP HOOK FEEDBACK\]/i.test(text)) {
    return "stop-feedback";
  }
  if (
    /\b(?:plan validation failed|validate_plan|iterate on the planfile|planfile validation remediation)\b/i.test(text) ||
    /\bplan[-_\s]?validate\b/i.test(tool)
  ) {
    return "plan-validation";
  }
  if (
    /\b(?:tool call denied|command blocked|tool call blocked|blocked by pretooluse|pretooluse denied|permission denied by hook)\b/i.test(text) ||
    /^\[[^\]]+\]\s*(?:denied|blocked):/i.test(text)
  ) {
    return "tool-denial";
  }
  if (
    message.isError === true ||
    /\b(?:explicit tool failure|posttoolusefailure|tool failed|command failed|exit code\s+\d+|process exited with code\s+\d+|structured failure output)\b/i.test(text)
  ) {
    return "tool-failure";
  }

  return null;
}

function stripToolSourcePrefix(message: TranscriptToolResultMessage): string {
  if (!message.toolName) return message.content;
  const prefix = `[${message.toolName}] `;
  return message.content.startsWith(prefix) ? message.content.slice(prefix.length) : message.content;
}

export function extractActionableToolResultFeedback(
  toolMessages: readonly TranscriptToolResultMessage[],
): PriorErrorContext[] {
  const contexts: PriorErrorContext[] = [];
  for (const message of toolMessages) {
    const source = classifyActionableToolResult(message);
    if (!source) continue;
    contexts.push({
      source,
      provenance: ["transcript"],
      tool: message.toolName,
      toolUseId: message.toolUseId,
      text: stripToolSourcePrefix(message),
      index: message.index,
      isError: message.isError,
    });
  }
  return contexts;
}

/**
 * Normalize a count specification to a consistent format.
 */
function normalizeCount(spec: CountSpec | undefined): CountSpec {
  if (spec === undefined) return { count: 0 };
  return spec;
}

/**
 * Validate a transcript configuration for logical consistency.
 */
export function validateTranscriptConfig(
  config: TranscriptReadOptions,
  configName: string
): void {
  const userSpec = normalizeCount(config.counts.user);
  const assistantSpec = normalizeCount(config.counts.assistant);
  const toolSpec = normalizeCount(config.counts.tool);

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
 */
export async function readTranscriptExact(
  transcriptPath: string,
  options: TranscriptReadOptions
): Promise<TranscriptReadResult> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");
  return readTranscriptExactFromEntries(
    parseActiveTranscriptLines(allLines, transcriptPath),
    options,
  );
}

/** Project one already-parsed, stable native observation into rule transcript context. */
export function readTranscriptExactFromEntries(
  parsedEntries: readonly (import("../adapter/types.js").TranscriptEntry | null)[],
  options: TranscriptReadOptions,
  spec: AdapterSpec = activeSpec(),
): TranscriptReadResult {
  const {
    counts,
    toolOptions = {},
    excludeSystemReminders = true,
    excludeSlashCommandPrompts = false,
    excludeMetaMessages = true,
    includeFirstUserMessage = false,
    includeSlashCommandContext = false,
  } = options;

  const userSpec = normalizeCount(counts.user);
  const assistantSpec = normalizeCount(counts.assistant);
  const toolSpec = normalizeCount(counts.tool);

  const targetUser = userSpec.count;
  const targetAssistant = assistantSpec.count;
  const targetTool = toolSpec.count;

  const collected: TranscriptReadResult = {
    user: [],
    assistant: [],
    tool: [],
    totalCount: 0,
  };

  const toolUseIdToName = new Map<string, string>();
  let slashCommandContext: SlashCommandContext | undefined;

  const assistantGroupByIndex = buildAssistantGroups(parsedEntries, "user-text-or-tool-result");
  collected.assistantTextCandidates = collectAssistantTextCandidates(
    parsedEntries,
    assistantSpec.count === Infinity ? parsedEntries.length : assistantSpec.count,
  );

  // First pass: build tool_use ID map + extract slash command context
  for (const entry of parsedEntries) {
    if (!entry) continue;

    if (entry.message?.role === "assistant" && Array.isArray(entry.message.content)) {
      for (const block of entry.message.content) {
        if (block.type === "tool_use" && block.id && block.name) {
          toolUseIdToName.set(block.id, block.name);
        }
      }
    }

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
        const metadata = extractSlashCommandMetadata(textContent, spec);
        if (metadata) {
          slashCommandContext = metadata;
        }
      }
    }
  }

  if (slashCommandContext) {
    collected.slashCommandContext = slashCommandContext;
  }

  let scanDistance = 0;
  let firstUserSeenIndex: number | null = null;
  const userLenBeforeIter = () => collected.user.length;

  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    scanDistance++;

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
      if (excludeMetaMessages && entry.isMeta === true) {
        continue;
      }

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
          collected.newestUserWasSlashCommand = isSlashCommandPrompt(probe, spec);
        }
      }

      const userStale = userSpec.maxStale !== undefined && scanDistance > userSpec.maxStale;
      const toolStale = toolSpec.maxStale !== undefined && scanDistance > toolSpec.maxStale;

      if (
        (!userStale && collected.user.length < targetUser) ||
        (!toolStale && collected.tool.length < targetTool)
      ) {
        const beforeLen = userLenBeforeIter();
        processUserEntry(msgContent, i, collected, {
          targetUser: userStale ? 0 : targetUser,
          targetTool: toolStale ? 0 : targetTool,
          excludeSystemReminders,
          excludeSlashCommandPrompts,
          toolOptions,
          toolUseIdToName,
          spec,
        });
        if (firstUserSeenIndex === null && collected.user.length > beforeLen) {
          firstUserSeenIndex = i;
        }
      }
    } else if (role === 'assistant' && collected.assistant.length < targetAssistant) {
      const group = assistantGroupByIndex.get(i);
      if (!group) continue;
      if (i !== group.lastIndex) continue;
      if (firstUserSeenIndex !== null && group.lastIndex < firstUserSeenIndex) {
        continue;
      }
      const assistantStale = assistantSpec.maxStale !== undefined && scanDistance > assistantSpec.maxStale;
      if (!assistantStale && group.text) {
        collected.assistant.push({ role: 'assistant', content: group.text, index: group.lastIndex });
      }
    }
  }

  if (includeFirstUserMessage && collected.user.length > 0) {
    const firstCollectedIndex = collected.user[0].index;

    if (firstCollectedIndex > 0) {
      for (let i = 0; i < parsedEntries.length; i++) {
        if (i >= firstCollectedIndex) break;

        const entry = parsedEntries[i];
        if (!entry || !entry.message || entry.message.role !== "user") continue;
        if (excludeMetaMessages && entry.isMeta === true) continue;

        const msgContent = entry.message.content;
        let text: string | undefined;

        if (typeof msgContent === "string") {
          if (excludeSystemReminders && msgContent.startsWith("<system-reminder>")) continue;
          if (excludeSlashCommandPrompts && isWorkflowInvocationOnlyPrompt(msgContent, spec)) continue;
          text = msgContent;
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              if (excludeSystemReminders && block.text.startsWith("<system-reminder>")) continue;
              if (excludeSlashCommandPrompts && isWorkflowInvocationOnlyPrompt(block.text, spec)) continue;
              text = block.text;
              break;
            }
          }
        }

        if (text) {
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
 * PreToolUse hook.
 */
export async function currentTurnAssistantState(
  transcriptPath: string,
  firingToolUseId?: string
): Promise<CurrentTurnAssistantState> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const allLines = content.trim().split("\n");
  const parsedEntries = parseActiveTranscriptLines(allLines, transcriptPath);

  let lastUserIndex = -1;
  for (let i = parsedEntries.length - 1; i >= 0; i--) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message || !userEntryHasHumanText(entry)) continue;
    lastUserIndex = i;
    break;
  }
  if (lastUserIndex === -1) {
    return { kind: "no-current-turn" };
  }

  const groups = buildAssistantGroups(parsedEntries, "human-user-text");

  let current: AssistantGroup | undefined;
  const seen = new Set<AssistantGroup>();
  if (firingToolUseId) {
    for (const group of groups.values()) {
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.toolUseIds.includes(firingToolUseId) && group.lastIndex > lastUserIndex) {
        current = group;
        break;
      }
    }
  }

  if (!current) {
    seen.clear();
    for (const group of groups.values()) {
      if (seen.has(group)) continue;
      seen.add(group);
      if (group.lastIndex <= lastUserIndex) continue;
      if (!current || group.lastIndex > current.lastIndex) current = group;
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
    spec: AdapterSpec;
  }
): void {
  const {
    targetUser,
    targetTool,
    excludeSystemReminders,
    excludeSlashCommandPrompts,
    toolOptions,
    toolUseIdToName,
    spec,
  } = config;
  const { trim = false, maxLines = 20, excludeToolNames = [] } = toolOptions ?? {};

  if (typeof msgContent === 'string') {
    if (excludeSystemReminders && msgContent.startsWith('<system-reminder>')) {
      return;
    }
    if (excludeSlashCommandPrompts && isWorkflowInvocationOnlyPrompt(msgContent, spec)) {
      return;
    }
    if (collected.user.length < targetUser) {
      collected.user.push({ role: 'user', content: msgContent, index: lineIndex });
    }
  } else if (Array.isArray(msgContent)) {
    for (const block of msgContent) {
      if (block.type === 'tool_result' && collected.tool.length < targetTool) {
        if (block.tool_use_id && excludeToolNames.length > 0) {
          const toolName = toolUseIdToName.get(block.tool_use_id);
          if (toolName && excludeToolNames.includes(toolName)) {
            continue;
          }
        }

        let toolContent = extractToolResultContent(block);

        if (toolContent && spec.isInterruptionMessage(toolContent)) {
          continue;
        }

        if (trim && toolContent) {
          toolContent = trimToolOutput(toolContent, maxLines);
        }
        if (toolContent) {
          const toolName = block.tool_use_id ? toolUseIdToName.get(block.tool_use_id) : undefined;
          const prefix = toolName ? `[${toolName}] ` : "";
          collected.tool.push({
            role: 'tool',
            content: `${prefix}${toolContent}`,
            index: lineIndex,
            toolUseId: block.tool_use_id,
            toolName,
            isError: block.is_error === true ? true : undefined,
          });
        }
      } else if (block.type === 'text' && block.text) {
        if (excludeSystemReminders && block.text.startsWith('<system-reminder>')) {
          continue;
        }
        if (excludeSlashCommandPrompts && isWorkflowInvocationOnlyPrompt(block.text, spec)) {
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
  user?: number;
  assistant?: number;
  tool?: number;
  assistantOrTool?: number;
}

/**
 * Check if transcript meets minimum requirements for agent processing.
 */
export function hasMinimumTranscript(
  result: TranscriptReadResult,
  requirements: MinimumTranscriptRequirements
): boolean {
  const { user = 0, assistant = 0, tool = 0, assistantOrTool } = requirements;

  if (result.user.length < user) return false;
  if (result.assistant.length < assistant) return false;
  if (result.tool.length < tool) return false;

  if (assistantOrTool !== undefined) {
    const combined = result.assistant.length + result.tool.length;
    if (combined < assistantOrTool) return false;
  }

  return true;
}

/**
 * Read the last N real user text messages from a transcript JSONL, oldest
 * first, separated by `---`.
 */
export async function readRecentUserMessages(
  transcriptPath: string,
  n: number,
  withIndices: boolean = false,
  opts: { stripQuoted?: boolean } = {},
): Promise<string> {
  const messages = await readRecentUserMessagesArray(transcriptPath, n, opts);
  const total = messages.length;
  return withIndices
    ? messages.map((msg, i) => `[T${total - 1 - i}] ${msg}`).join("\n---\n")
    : messages.join("\n---\n");
}

/**
 * Array-returning sibling of `readRecentUserMessages`.
 */
export async function readRecentUserMessagesArray(
  transcriptPath: string,
  n: number,
  opts: { stripQuoted?: boolean } = {},
): Promise<string[]> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return [];
  }
  const lines = raw.trim().split("\n");
  return recentUserMessagesFromEntries(parseActiveTranscriptLines(lines, transcriptPath), n, opts);
}

/** Select recent human user messages from one already-parsed observation. */
export function recentUserMessagesFromEntries(
  parsedEntries: readonly (import("../adapter/types.js").TranscriptEntry | null)[],
  n: number,
  opts: { stripQuoted?: boolean } = {},
  spec: AdapterSpec = activeSpec(),
): string[] {
  const collected: string[] = [];
  for (let i = parsedEntries.length - 1; i >= 0 && collected.length < n; i--) {
    const entry = parsedEntries[i];
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;

    const content = entry.message.content;
    let text: string | undefined;
    if (typeof content === "string") {
      if (content.startsWith("<system-reminder>")) continue;
      if (isWorkflowInvocationOnlyPrompt(content, spec)) continue;
      text = content;
    } else if (Array.isArray(content)) {
      let foundText: string | undefined;
      let onlyToolResults = true;
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (block.text.startsWith("<system-reminder>")) continue;
          if (isWorkflowInvocationOnlyPrompt(block.text, spec)) continue;
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
    const message = opts.stripQuoted === false ? text : stripQuotedAndPastedContent(text);
    if (!message.trim()) continue;
    collected.push(message);
  }
  return collected.reverse();
}

/**
 * Determine whether the user-text turn whose RAW first text block startsWith
 * `snippet.trim()` has been followed by at least one COMPLETED non-error
 * assistant tool round-trip.
 */
export async function userTurnFollowedByCompletedToolRoundtrip(
  transcriptPath: string,
  snippet: string,
): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(transcriptPath, "utf-8");
  } catch {
    return false;
  }
  const lines = raw.trim().split("\n");
  return userTurnFollowedByCompletedToolRoundtripFromEntries(
    parseActiveTranscriptLines(lines, transcriptPath),
    snippet,
  );
}

/** Evaluate completed-roundtrip evidence from one already-parsed observation. */
export function userTurnFollowedByCompletedToolRoundtripFromEntries(
  parsed: readonly (import("../adapter/types.js").TranscriptEntry | null)[],
  snippet: string,
  spec: AdapterSpec = activeSpec(),
): boolean {
  const trimmed = snippet.trim();
  if (!trimmed) return false;

  let anchorIndex = -1;
  for (let i = parsed.length - 1; i >= 0; i--) {
    const entry = parsed[i];
    if (!entry || !entry.message || entry.message.role !== "user") continue;
    if (entry.isMeta === true) continue;
    const content = entry.message.content;
    let firstText: string | undefined;
    if (typeof content === "string") {
      if (content.startsWith("<system-reminder>")) continue;
      if (isWorkflowInvocationOnlyPrompt(content, spec)) continue;
      firstText = content;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && block.text) {
          if (block.text.startsWith("<system-reminder>")) continue;
          if (isWorkflowInvocationOnlyPrompt(block.text, spec)) continue;
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
      let text = "";
      if (typeof block.content === "string") text = block.content;
      else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner.type === "text" && inner.text) text += inner.text;
        }
      }
      if (text && spec.isInterruptionMessage(text)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Resolve the active slash-command workflow's authorized tool list.
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
  return resolveActiveSlashCommandAllowedToolsFromEntries(
    parseActiveTranscriptLines(lines, transcriptPath),
  );
}

/** Resolve workflow authorization from one already-parsed observation. */
export function resolveActiveSlashCommandAllowedToolsFromEntries(
  parsed: readonly (import("../adapter/types.js").TranscriptEntry | null)[],
  spec: AdapterSpec = activeSpec(),
): readonly string[] | undefined {
  for (let i = parsed.length - 1; i >= 0; i--) {
    const entry = parsed[i];
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
    if (!isSlashCommandPrompt(text, spec)) continue;

    const metadata = extractSlashCommandMetadata(text, spec);
    if (metadata?.allowedTools && metadata.allowedTools.length > 0) {
      return metadata.allowedTools;
    }
  }
  return undefined;
}

export interface ParallelBatchInfo {
  position: number;
  batchSize: number;
  leaderId: string;
  allIds: string[];
  members: ParallelBatchMember[];
}

export interface ParallelBatchMember {
  position: number;
  toolUseId: string;
  toolName: string;
  toolInput?: unknown;
}

/**
 * Detect if a tool_use_id belongs to a parallel batch.
 */
export async function detectParallelBatch(
  transcriptPath: string,
  toolUseId: string,
): Promise<ParallelBatchInfo | null> {
  const content = await fs.promises.readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n");
  return detectParallelBatchFromEntries(
    parseActiveTranscriptLines(lines, transcriptPath),
    toolUseId,
  );
}

/** Detect a parallel batch from one already-parsed observation. */
export function detectParallelBatchFromEntries(
  parsed: readonly (import("../adapter/types.js").TranscriptEntry | null)[],
  toolUseId: string,
  spec: AdapterSpec = activeSpec(),
): ParallelBatchInfo | null {

  interface ToolUseEntry {
    lineIndex: number;
    toolUseId: string;
    toolName: string;
    toolInput?: unknown;
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
          toolInput: block.input,
        });
      }
    }
  }

  const targetEntry = toolUseEntries.find((e) => e.toolUseId === toolUseId);

  function isAssistantToolUseLine(lineIdx: number): boolean {
    return toolUseEntries.some((e) => e.lineIndex === lineIdx);
  }

  function isNonMessageLine(lineIdx: number): boolean {
    const entry = parsed[lineIdx];
    if (!entry) return false;
    return !entry.message;
  }

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

  const batchLineIndices = new Set<number>();

  if (targetEntry) {
    batchLineIndices.add(targetEntry.lineIndex);

    for (let i = targetEntry.lineIndex - 1; i >= 0; i--) {
      if (isNonMessageLine(i) || isThinkingOnlyLine(i)) continue;
      if (isAssistantToolUseLine(i)) {
        batchLineIndices.add(i);
        continue;
      }
      break;
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
    if (!spec.canInferUnflushedParallelToolUse(toolUseId)) return null;
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

  const sortedLineIndices = Array.from(batchLineIndices).sort((a, b) => a - b);
  const members: ParallelBatchMember[] = [];
  for (const lineIdx of sortedLineIndices) {
    for (const entry of toolUseEntries) {
      if (entry.lineIndex === lineIdx) {
        members.push({
          position: members.length,
          toolUseId: entry.toolUseId,
          toolName: entry.toolName,
          toolInput: entry.toolInput,
        });
      }
    }
  }

  if (!targetEntry) {
    members.push({
      position: members.length,
      toolUseId,
      toolName: "",
    });
  }

  const batchIds = members.map((member) => member.toolUseId);
  if (batchIds.length < 2) return null;

  const position = batchIds.indexOf(toolUseId);
  return {
    position,
    batchSize: batchIds.length,
    leaderId: batchIds[0],
    allIds: batchIds,
    members,
  };
}

/**
 * Find the most recent message by transcript index.
 */
export function getMostRecentMessage(messages: TranscriptMessage[]): TranscriptMessage {
  return messages.reduce((latest, msg) =>
    msg.index > latest.index ? msg : latest
  );
}
