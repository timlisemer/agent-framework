/**
 * Codex transcript parser — the bug fix.
 *
 * Codex emits one logical assistant turn as N consecutive JSONL lines:
 *   - one `payload.type:"message"` line (role: "assistant", with text content)
 *   - N-1 `payload.type:"function_call"` lines (one per tool call)
 *
 * The old per-line normalizeTranscriptEntry produced N separate TranscriptEntry
 * objects, causing buildAssistantGroups to split them across groups (keyed on
 * message.id). currentTurnAssistantState then selected the tool_use group with
 * empty text, causing respond-first to falsely deny.
 *
 * This parser coalesces consecutive assistant-role lines into ONE canonical
 * TranscriptEntry whose content is [{text}, {tool_use}, {tool_use}, ...] —
 * the exact same shape Claude Code emits natively.
 *
 * @module adapters/codex/parse-transcript
 */

import type { TranscriptEntry, ContentBlock } from "../../src/adapter/types.js";

function normalizeContentBlock(block: unknown): ContentBlock | null {
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

function normalizeToolName(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  return `${namespace}${name}`;
}

function assistantMessageContent(payload: Record<string, unknown>): ContentBlock[] {
  const rawContent = payload.content;
  const contentBlocks: ContentBlock[] = [];

  if (typeof rawContent === "string") {
    if (rawContent) contentBlocks.push({ type: "text", text: rawContent });
  } else if (Array.isArray(rawContent)) {
    for (const b of rawContent) {
      const normalized = normalizeContentBlock(b);
      if (normalized) contentBlocks.push(normalized);
    }
  }

  return contentBlocks;
}

function eventMsgAgentMessageContent(payload: Record<string, unknown>): ContentBlock[] | null {
  if (payload.type !== "agent_message") return null;
  if (typeof payload.message !== "string" || payload.message.length === 0) return null;
  return [{ type: "text", text: payload.message }];
}

function eventMsgCompletedPlanContent(payload: Record<string, unknown>): ContentBlock[] | null {
  if (payload.type !== "item_completed") return null;
  const item = payload.item;
  if (!item || typeof item !== "object") return null;

  const plan = item as Record<string, unknown>;
  if (plan.type !== "Plan") return null;
  if (typeof plan.text !== "string" || plan.text.length === 0) return null;

  return [{ type: "text", text: `<proposed_plan>\n${plan.text}\n</proposed_plan>` }];
}

interface RawEntry {
  isMeta?: boolean;
  type?: string;
  payload?: Record<string, unknown>;
  message?: unknown;
}

/**
 * Parse Codex JSONL lines into canonical TranscriptEntry objects, coalescing
 * multi-line assistant turns (text message + function_call items) into one
 * canonical entry per logical turn.
 */
export function parseTranscript(rawLines: readonly string[]): readonly (TranscriptEntry | null)[] {
  // First pass: parse each raw line into a typed object
  const parsed: Array<{ raw: RawEntry | null; line: string }> = rawLines.map((line) => {
    try {
      return { raw: JSON.parse(line) as RawEntry, line };
    } catch {
      return { raw: null, line };
    }
  });

  const result: (TranscriptEntry | null)[] = [];

  let i = 0;
  while (i < parsed.length) {
    const { raw } = parsed[i];

    if (!raw) {
      result.push(null);
      i++;
      continue;
    }

    // Already canonical (scenario fixtures or non-Codex entries)
    if (raw.message) {
      result.push(raw as TranscriptEntry);
      i++;
      continue;
    }

    const payload = raw.payload;
    if (!payload || typeof payload !== "object") {
      result.push({ isMeta: raw.isMeta });
      i++;
      continue;
    }

    const payloadType = payload.type as string | undefined;

    if (raw.type === "event_msg") {
      const completedPlanContent = eventMsgCompletedPlanContent(payload);
      if (completedPlanContent) {
        result.push({
          isMeta: raw.isMeta,
          message: {
            id: typeof payload.id === "string" ? payload.id : undefined,
            role: "assistant",
            content: completedPlanContent,
          },
        });
        i++;
        continue;
      }

      const contentBlocks = eventMsgAgentMessageContent(payload);
      if (contentBlocks) {
        const msgId = typeof payload.id === "string" ? payload.id : undefined;
        i++;

        while (i < parsed.length) {
          const next = parsed[i].raw;
          if (!next?.payload || typeof next.payload !== "object") break;
          const nextPayload = next.payload;
          const nextType = nextPayload.type as string | undefined;
          if (nextType === "message" && nextPayload.role === "assistant") {
            contentBlocks.push(...assistantMessageContent(nextPayload));
            i++;
            continue;
          }
          if (nextType !== "function_call" && nextType !== "custom_tool_call") break;

          contentBlocks.push({
            type: "tool_use",
            id: typeof nextPayload.call_id === "string" ? nextPayload.call_id : undefined,
            name: normalizeToolName(nextPayload),
          });
          i++;
        }

        result.push({
          isMeta: raw.isMeta,
          message: {
            id: msgId,
            role: "assistant",
            content: contentBlocks,
          },
        });
        continue;
      }
    }

    // Assistant text message — open an assistant turn and greedily collect
    // subsequent function_call lines into the same canonical entry.
    if (payloadType === "message") {
      const role = typeof payload.role === "string" ? payload.role : "";

      if (role === "assistant") {
        // Collect text content from this message line
        const contentBlocks = assistantMessageContent(payload);

        const msgId = typeof payload.id === "string" ? payload.id : undefined;

        // Advance past the text message line
        i++;

        // Greedily consume consecutive function_call / custom_tool_call lines
        while (i < parsed.length) {
          const next = parsed[i].raw;
          if (!next) break;
          const nextPayload = next.payload;
          if (!nextPayload || typeof nextPayload !== "object") break;
          const nextType = (nextPayload as Record<string, unknown>).type as string | undefined;
          if (nextType !== "function_call" && nextType !== "custom_tool_call") break;

          const np = nextPayload as Record<string, unknown>;
          const callId = typeof np.call_id === "string" ? np.call_id : undefined;
          contentBlocks.push({
            type: "tool_use",
            id: callId,
            name: normalizeToolName(np),
          });
          i++;
        }

        result.push({
          isMeta: raw.isMeta,
          message: {
            id: msgId,
            role: "assistant",
            content: contentBlocks,
          },
        });
        continue;
      }

      if (role === "user") {
        const rawContent = payload.content;
        let content: string | ContentBlock[] = "";
        if (typeof rawContent === "string") {
          content = rawContent;
        } else if (Array.isArray(rawContent)) {
          content = rawContent
            .map(normalizeContentBlock)
            .filter((b): b is ContentBlock => b !== null);
        }
        result.push({
          isMeta: raw.isMeta,
          message: {
            id: typeof payload.id === "string" ? payload.id : undefined,
            role: "user",
            content,
          },
        });
        i++;
        continue;
      }

      // Other roles: treat as meta
      result.push({ isMeta: raw.isMeta });
      i++;
      continue;
    }

    // Standalone function_call (not preceded by a message line) —
    // emit as a singleton assistant entry with tool_use content.
    if (payloadType === "function_call" || payloadType === "custom_tool_call") {
      const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
      result.push({
        message: {
          id: typeof payload.id === "string" ? payload.id : callId,
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: callId,
              name: normalizeToolName(payload),
            },
          ],
        },
      });
      i++;
      continue;
    }

    // function_call_output → user tool_result
    if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
      result.push({
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: typeof payload.call_id === "string" ? payload.call_id : undefined,
              content: typeof payload.output === "string"
                ? payload.output
                : JSON.stringify(payload.output ?? ""),
            },
          ],
        },
      });
      i++;
      continue;
    }

    // Unknown payload type
    result.push({ isMeta: raw.isMeta });
    i++;
  }

  return result;
}
