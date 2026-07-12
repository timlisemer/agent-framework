/**
 * Codex transcript parser.
 *
 * Codex can write one logical assistant answer in two raw shapes:
 * `event_msg`/`agent_message` and `response_item`/assistant `message`.
 * This parser collapses that pair at the canonical adapter boundary and
 * attaches stable source keys for downstream live/resume projection.
 *
 * @module adapters/codex/parse-transcript
 */

import type {
  ContentBlock,
  TranscriptEntry,
  TranscriptParseOptions,
  TranscriptSource,
} from "../../src/adapter/types.js";
import { isRecord, nonEmptyStringField } from "../../src/utils/output.js";
import { buildLineTranscriptSource, withTranscriptSource } from "../shared/transcript-source.js";
import type { TokenUsage } from "../../src/ai-protocol/index.js";
import { AGENT_FRAMEWORK_METADATA_KEYS } from "../../src/utils/agent-framework-metadata.js";
import { isToolLogFailureStatus } from "../../src/utils/agent-framework-tool-log.js";
import { normalizeCodexToolName, parseCodexToolObjectInput } from "./tool-payload.js";
import { normalizeCodexTokenUsage } from "./usage.js";

const ADAPTER = "codex";
const CODEX_WRAPPED_USER_MARKER = "\n\nUser request:\n";
const METADATA_PAYLOAD_TYPES = new Set([
  "token_count",
  "rate_limits",
  "turn_context",
  "session_meta",
  "conversation_context",
]);

interface RawEntry {
  isMeta?: boolean;
  type?: string;
  timestamp?: string;
  created_at?: string;
  createdAt?: string;
  payload?: Record<string, unknown>;
  message?: unknown;
}

/**
 * Codex transcript-level tool calls use provider call IDs. Nested tools run
 * inside a custom `exec` call have host-generated IDs such as `exec-...` and
 * never receive their own rollout row, so they cannot be inferred as an
 * unflushed sibling of the transcript's outer call.
 */
export function canInferUnflushedParallelToolUse(toolUseId: string): boolean {
  return toolUseId.startsWith("call_");
}

type ParsedLine = {
  raw: RawEntry | null;
  line: string;
  lineNumber: number;
};

function normalizeContentBlock(block: unknown, source: TranscriptSource): ContentBlock | null {
  if (!block || typeof block !== "object") return null;
  const input = block as Record<string, unknown>;
  const type = typeof input.type === "string" ? input.type : "";

  if (type === "input_text" || type === "output_text") {
    const text = typeof input.text === "string" ? input.text : "";
    return { type: "text", text, source };
  }

  if (type === "text" || type === "thinking" || type === "tool_use" || type === "tool_result") {
    return {
      type,
      text: typeof input.text === "string" ? input.text : undefined,
      content: "content" in input ? input.content : undefined,
      tool_use_id: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined,
      name: typeof input.name === "string" ? input.name : undefined,
      id: typeof input.id === "string" ? input.id : undefined,
      input: isRecord(input.input) ? input.input : undefined,
      is_error: typeof input.is_error === "boolean" ? input.is_error : undefined,
      source,
    };
  }

  return null;
}

function assistantMessageContent(payload: Record<string, unknown>, source: TranscriptSource): ContentBlock[] {
  const rawContent = payload.content ?? payload.text;
  const contentBlocks: ContentBlock[] = [];

  if (typeof rawContent === "string") {
    if (rawContent) contentBlocks.push({ type: "text", text: rawContent, source });
  } else if (Array.isArray(rawContent)) {
    for (const b of rawContent) {
      const normalized = normalizeContentBlock(b, source);
      if (normalized) contentBlocks.push(normalized);
    }
  }

  return contentBlocks;
}

function eventMsgAgentMessageContent(payload: Record<string, unknown>, source: TranscriptSource): ContentBlock[] | null {
  if (payload.type !== "agent_message") return null;
  if (typeof payload.message !== "string" || payload.message.length === 0) return null;
  return [{ type: "text", text: payload.message, source }];
}

function eventMsgCompletedPlanContent(payload: Record<string, unknown>, source: TranscriptSource): ContentBlock[] | null {
  if (payload.type !== "item_completed") return null;
  const item = payload.item;
  if (!item || typeof item !== "object") return null;

  const plan = item as Record<string, unknown>;
  if (plan.type !== "Plan") return null;
  if (typeof plan.text !== "string" || plan.text.length === 0) return null;

  return [{ type: "text", text: `<proposed_plan>\n${plan.text}\n</proposed_plan>`, source }];
}

/**
 * Parse Codex JSONL lines into canonical TranscriptEntry objects, coalescing
 * multi-line assistant turns into one canonical entry per logical turn.
 */
export function parseTranscript(
  rawLines: readonly string[],
  options: TranscriptParseOptions = {}
): readonly (TranscriptEntry | null)[] {
  const parsed: ParsedLine[] = rawLines.map((line, index) => {
    try {
      return {
        raw: JSON.parse(line) as RawEntry,
        line,
        lineNumber: (options.startLine ?? 1) + index,
      };
    } catch {
      return {
        raw: null,
        line,
        lineNumber: (options.startLine ?? 1) + index,
      };
    }
  });

  const result: (TranscriptEntry | null)[] = [];

  let i = 0;
  while (i < parsed.length) {
    const current = parsed[i];
    const { raw } = current;

    if (!raw) {
      result.push(null);
      i++;
      continue;
    }

    // Already canonical (scenario fixtures or non-Codex entries).
    if (raw.message) {
      const source = sourceFor("canonical", current, current, options, messageId(raw.message));
      result.push(withTranscriptSource(raw as TranscriptEntry, source));
      i++;
      continue;
    }

    const payload = raw.payload;
    if (!payload || typeof payload !== "object") {
      result.push(metaEntry(current, current, options));
      i++;
      continue;
    }

    const payloadType = payload.type as string | undefined;
    const role = typeof payload.role === "string" ? payload.role : "";

    if (raw.type === "event_msg") {
      const source = sourceFor("assistant", current, current, options, nonEmptyStringField(payload, "id"));
      const completedPlanContent = eventMsgCompletedPlanContent(payload, source);
      if (completedPlanContent) {
        result.push({
          isMeta: raw.isMeta,
          source,
          createdAt: source.createdAt,
          message: {
            id: typeof payload.id === "string" ? payload.id : undefined,
            role: "assistant",
            content: completedPlanContent,
          },
        });
        i++;
        continue;
      }

      const contentBlocks = eventMsgAgentMessageContent(payload, source);
      if (contentBlocks) {
        const msgId = typeof payload.id === "string" ? payload.id : undefined;
        const consumed = consumeAssistantTurn({
          parsed,
          index: i,
          options,
          contentBlocks,
          msgId,
          usage: null,
          allowPairedAssistantMessage: true,
        });
        result.push(consumed.entry);
        i = consumed.nextIndex;
        continue;
      }
    }

    if (isAssistantMessagePayload(payloadType, role)) {
      const contentBlocks = assistantMessageContent(
        payload,
        sourceFor("assistant", current, current, options, nonEmptyStringField(payload, "id"))
      );
      const msgId = typeof payload.id === "string" ? payload.id : undefined;
      const consumed = consumeAssistantTurn({
        parsed,
        index: i,
        options,
        contentBlocks,
        msgId,
        usage: tokenUsageFromRaw(raw),
        allowPairedAssistantMessage: false,
      });
      result.push(consumed.entry);
      i = consumed.nextIndex;
      continue;
    }

    if (isUserMessagePayload(payloadType, role)) {
      const source = sourceFor("user", current, current, options, nonEmptyStringField(payload, "id"));
      const normalized = userMessageContent(payload, source);
      result.push({
        isMeta: raw.isMeta,
        source,
        createdAt: source.createdAt,
        ...(normalized.metadata ? { metadata: normalized.metadata } : {}),
        message: {
          id: typeof payload.id === "string" ? payload.id : undefined,
          role: "user",
          content: normalized.content,
        },
      });
      i++;
      continue;
    }

    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const callSource = sourceFor("tool", current, current, options, nonEmptyStringField(payload, "call_id"));
      result.push({
        source: callSource,
        createdAt: callSource.createdAt,
        message: {
          id: typeof payload.id === "string" ? payload.id : nonEmptyStringField(payload, "call_id") ?? undefined,
          role: "assistant",
          content: [toolUseBlock(payload, callSource)],
        },
      });
      i++;
      continue;
    }

    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      const source = sourceFor("tool-result", current, current, options, nonEmptyStringField(payload, "call_id"));
      result.push({
        source,
        createdAt: source.createdAt,
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: typeof payload.call_id === "string" ? payload.call_id : undefined,
              content: payload.error ?? payload.output ?? payload.result ?? "",
              is_error: isToolLogFailureStatus(nonEmptyStringField(payload, "status")) || payload.error !== undefined,
              source,
            },
          ],
        },
      });
      i++;
      continue;
    }

    result.push(metaEntry(current, current, options));
    i++;
  }

  return result;
}

function isAssistantMessagePayload(payloadType: string | undefined, role: string): boolean {
  return (payloadType === "message" || payloadType === undefined) && role === "assistant";
}

function isUserMessagePayload(payloadType: string | undefined, role: string): boolean {
  return (payloadType === "message" || payloadType === undefined) && role === "user";
}

function consumeAssistantTurn(input: {
  parsed: readonly ParsedLine[];
  index: number;
  options: TranscriptParseOptions;
  contentBlocks: ContentBlock[];
  msgId?: string;
  usage: TokenUsage | null;
  allowPairedAssistantMessage: boolean;
}): { entry: TranscriptEntry; nextIndex: number } {
  const start = input.parsed[input.index];
  let end = start;
  let usage = input.usage;
  let i = input.index + 1;

  while (i < input.parsed.length) {
    const next = input.parsed[i];
    const nextPayload = next.raw?.payload;
    if (next.raw && isMetadataOnlyRaw(next.raw)) {
      usage = tokenUsageFromRaw(next.raw) ?? usage;
      end = next;
      i++;
      continue;
    }
    if (!nextPayload || typeof nextPayload !== "object") break;
    const nextType = nextPayload.type as string | undefined;
    const nextRole = typeof nextPayload.role === "string" ? nextPayload.role : "";
    if (input.allowPairedAssistantMessage && isAssistantMessagePayload(nextType, nextRole)) {
      const nextSource = sourceFor(
        "assistant",
        start,
        next,
        input.options,
        input.msgId ?? nonEmptyStringField(nextPayload, "id")
      );
      pushNonDuplicateAssistantContent(input.contentBlocks, assistantMessageContent(nextPayload, nextSource));
      end = next;
      i++;
      continue;
    }
    if (nextType !== "function_call" && nextType !== "custom_tool_call") break;

    input.contentBlocks.push(toolUseBlock(
      nextPayload,
      sourceFor("tool", next, next, input.options, nonEmptyStringField(nextPayload, "call_id"))
    ));
    end = next;
    i++;
  }

  const entrySource = sourceFor("assistant", start, end, input.options, input.msgId);
  return {
    entry: {
      isMeta: start.raw?.isMeta,
      source: entrySource,
      createdAt: entrySource.createdAt,
      usage,
      message: {
        id: input.msgId,
        role: "assistant",
        content: input.contentBlocks.map((block) => block.source ? block : { ...block, source: entrySource }),
      },
    },
    nextIndex: i,
  };
}

function userMessageContent(
  payload: Record<string, unknown>,
  source: TranscriptSource
): { content: string | ContentBlock[]; metadata?: Record<string, string> } {
  const rawContent = payload.content ?? payload.text;
  if (typeof rawContent === "string") {
    const normalized = normalizeWrappedUserText(rawContent);
    return normalized.wrappedInput
      ? {
          content: normalized.text,
          metadata: { [AGENT_FRAMEWORK_METADATA_KEYS.wrappedInput]: normalized.wrappedInput },
        }
      : { content: rawContent };
  }
  if (!Array.isArray(rawContent)) return { content: "" };
  const metadata: Record<string, string> = {};
  const content = rawContent
    .map((block) => normalizeContentBlock(block, source))
    .filter((block): block is ContentBlock => block !== null)
    .map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") return block;
      const normalized = normalizeWrappedUserText(block.text);
      if (!normalized.wrappedInput) return block;
      metadata[AGENT_FRAMEWORK_METADATA_KEYS.wrappedInput] = normalized.wrappedInput;
      return { ...block, text: normalized.text };
    });
  return Object.keys(metadata).length > 0 ? { content, metadata } : { content };
}

function normalizeWrappedUserText(text: string): { text: string; wrappedInput?: string } {
  if (!text.startsWith("System instructions:\n")) return { text };
  const marker = text.indexOf(CODEX_WRAPPED_USER_MARKER);
  if (marker < 0) return { text };
  return {
    text: text.slice(marker + CODEX_WRAPPED_USER_MARKER.length),
    wrappedInput: text,
  };
}

function pushNonDuplicateAssistantContent(target: ContentBlock[], incoming: readonly ContentBlock[]): void {
  const targetText = visibleText(target);
  const incomingText = visibleText(incoming);
  if (targetText && incomingText && targetText === incomingText) return;
  target.push(...incoming);
}

function visibleText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

function toolUseBlock(payload: Record<string, unknown>, source: TranscriptSource): ContentBlock {
  return {
    type: "tool_use",
    id: typeof payload.call_id === "string" ? payload.call_id : undefined,
    name: normalizeCodexToolName(payload),
    input: parseCodexToolObjectInput(payload),
    source,
  };
}

function metaEntry(start: ParsedLine, end: ParsedLine, options: TranscriptParseOptions): TranscriptEntry {
  const source = sourceFor("meta", start, end, options);
  return { isMeta: true, source, createdAt: source.createdAt };
}

function sourceFor(
  kind: string,
  start: ParsedLine,
  end: ParsedLine,
  options: TranscriptParseOptions,
  nativeId?: string | null
): TranscriptSource {
  return buildLineTranscriptSource({
    adapter: ADAPTER,
    kind,
    transcriptPath: options.transcriptPath,
    startLine: start.lineNumber,
    endLine: end.lineNumber,
    nativeId,
    raw: start.raw,
  });
}

function isMetadataOnlyRaw(raw: RawEntry): boolean {
  if (raw.isMeta === true) return true;
  if (raw.type === "session_meta") return true;
  if (!raw.payload || typeof raw.payload !== "object") return false;
  const type = typeof raw.payload.type === "string" ? raw.payload.type : "";
  return METADATA_PAYLOAD_TYPES.has(type);
}

function tokenUsageFromRaw(raw: RawEntry | null): TokenUsage | null {
  if (!raw?.payload || typeof raw.payload !== "object") return null;
  if (raw.payload.type !== "token_count") return null;
  return normalizeCodexTokenUsage(raw.payload);
}

function messageId(message: unknown): string | null {
  return isRecord(message) && typeof message.id === "string" ? message.id : null;
}

// Re-export ContentBlock so scenario-materializer can use it without importing from src/.
export type { ContentBlock };
