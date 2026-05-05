/**
 * Codex scenario materializer.
 *
 * Converts canonical ScenarioEntry objects into Codex JSONL wire format.
 * Emits payload.type:"message" for text turns and payload.type:"function_call"
 * lines for tool_use blocks — matching what Codex actually writes to disk.
 *
 * @module adapters/codex/scenario-materializer
 */

import * as crypto from "crypto";
import type { ScenarioMaterializeCtx, MaterializedScenarioLine } from "../../src/adapter/types.js";

type ScenarioBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id?: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string | unknown[]; is_error?: boolean };

function assignToolUseIds(blocks: ScenarioBlock[], counter: { n: number }): void {
  for (const b of blocks) {
    if (b.type === "tool_use" && !b.id) {
      counter.n += 1;
      (b as { id: string }).id = `toolu_scenario_${counter.n}`;
    }
  }
}

/**
 * Materialize a single ScenarioEntry into one or more Codex JSONL lines.
 */
export function materializeScenarioEntry(
  entry: unknown,
  ctx: ScenarioMaterializeCtx,
): readonly MaterializedScenarioLine[] {
  const e = entry as {
    role: string;
    content?: unknown;
    isMeta?: boolean;
    lines?: Array<{ blocks: ScenarioBlock[] }>;
    msg_id?: string;
  };

  const counter = { n: 0 };
  const ts = ctx.baseTs;

  if (e.role === "user") {
    const content = e.content;
    const uuid = crypto.randomUUID();

    // Emit a user message payload
    const line: Record<string, unknown> = {
      parentUuid: ctx.prevUuid,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      uuid,
      timestamp: new Date(ts).toISOString(),
      payload: {
        type: "message",
        role: "user",
        content: typeof content === "string" ? content : JSON.stringify(content),
      },
    };
    if (e.isMeta === true) line.isMeta = true;

    // Also emit tool_result blocks as function_call_output if content is array
    if (Array.isArray(content)) {
      const results: MaterializedScenarioLine[] = [];
      let prevUuid = ctx.prevUuid;
      for (const block of content as ScenarioBlock[]) {
        if (block.type === "tool_result") {
          const resultUuid = crypto.randomUUID();
          const resultLine: Record<string, unknown> = {
            parentUuid: prevUuid,
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            uuid: resultUuid,
            timestamp: new Date(ts).toISOString(),
            payload: {
              type: "function_call_output",
              call_id: block.tool_use_id,
              output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
            },
          };
          results.push({ jsonl: JSON.stringify(resultLine), uuid: resultUuid, toolUseIds: [] });
          prevUuid = resultUuid;
        } else if (block.type === "text") {
          const textUuid = crypto.randomUUID();
          const textLine: Record<string, unknown> = {
            parentUuid: prevUuid,
            sessionId: ctx.sessionId,
            cwd: ctx.cwd,
            uuid: textUuid,
            timestamp: new Date(ts).toISOString(),
            payload: {
              type: "message",
              role: "user",
              content: block.text,
            },
          };
          if (e.isMeta === true) textLine.isMeta = true;
          results.push({ jsonl: JSON.stringify(textLine), uuid: textUuid, toolUseIds: [] });
          prevUuid = textUuid;
        }
      }
      if (results.length > 0) return results;
    }

    return [{ jsonl: JSON.stringify(line), uuid, toolUseIds: [] }];
  }

  if (e.role === "assistant") {
    const blocks = (e.content ?? []) as ScenarioBlock[];
    assignToolUseIds(blocks, counter);
    return emitAssistantBlocks(blocks, ctx, ts);
  }

  if (e.role === "assistant_split") {
    const lines = (e.lines ?? []) as Array<{ blocks: ScenarioBlock[] }>;
    const results: MaterializedScenarioLine[] = [];
    let prevUuid = ctx.prevUuid;
    for (let j = 0; j < lines.length; j++) {
      const subBlocks = lines[j].blocks;
      assignToolUseIds(subBlocks, counter);
      const subCtx: ScenarioMaterializeCtx = {
        ...ctx,
        prevUuid,
        baseTs: ts + j * 10,
      };
      const subResults = emitAssistantBlocks(subBlocks, subCtx, ts + j * 10);
      for (const r of subResults) {
        results.push(r);
        prevUuid = r.uuid;
      }
    }
    return results;
  }

  return [];
}

function emitAssistantBlocks(
  blocks: ScenarioBlock[],
  ctx: ScenarioMaterializeCtx,
  ts: number,
): MaterializedScenarioLine[] {
  const results: MaterializedScenarioLine[] = [];
  let prevUuid = ctx.prevUuid;

  // Separate text blocks from tool_use blocks
  const textBlocks = blocks.filter((b) => b.type === "text" || b.type === "thinking");
  const toolUseBlocks = blocks.filter((b) => b.type === "tool_use") as Array<{
    type: "tool_use"; id?: string; name: string; input: Record<string, unknown>;
  }>;

  // Emit text as a message payload if any text content
  if (textBlocks.length > 0) {
    const textContent = textBlocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    const uuid = crypto.randomUUID();
    const line: Record<string, unknown> = {
      parentUuid: prevUuid,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      uuid,
      timestamp: new Date(ts).toISOString(),
      payload: {
        type: "message",
        role: "assistant",
        content: textContent,
      },
    };
    results.push({ jsonl: JSON.stringify(line), uuid, toolUseIds: [] });
    prevUuid = uuid;
  }

  // Emit each tool_use as a separate function_call payload
  for (const b of toolUseBlocks) {
    const uuid = crypto.randomUUID();
    const callId = b.id ?? uuid;
    const line: Record<string, unknown> = {
      parentUuid: prevUuid,
      sessionId: ctx.sessionId,
      cwd: ctx.cwd,
      uuid,
      timestamp: new Date(ts).toISOString(),
      payload: {
        type: "function_call",
        call_id: callId,
        name: b.name,
        arguments: JSON.stringify(b.input),
      },
    };
    results.push({
      jsonl: JSON.stringify(line),
      uuid,
      toolUseIds: [{ refKey: b.id ?? callId, resolvedId: callId }],
    });
    prevUuid = uuid;
  }

  return results;
}
