/**
 * Claude scenario materializer.
 *
 * Converts canonical ScenarioEntry objects into Claude Code JSONL wire format.
 * Emits one JSONL line per canonical entry (user, assistant) or one line per
 * sub-line for assistant_split entries.
 *
 * @module adapters/claude/scenario-materializer
 */

import * as crypto from "crypto";
import type { ScenarioMaterializeCtx, MaterializedScenarioLine } from "../../src/adapter/types.js";
import { assignScenarioToolUseIds } from "../../src/scenario/materialize-utils.js";
import type { ScenarioBlock } from "../../src/scenario/types.js";

function emitAssistantJsonl(
  blocks: ScenarioBlock[],
  msgId: string,
  ctx: ScenarioMaterializeCtx,
  entryTs: number,
  counter: { n: number },
): MaterializedScenarioLine {
  assignScenarioToolUseIds(blocks, counter);
  const hasToolUse = blocks.some((b) => b.type === "tool_use");
  const uuid = crypto.randomUUID();
  const message: Record<string, unknown> = {
    id: msgId,
    model: "claude-opus-4-6",
    role: "assistant",
    content: blocks,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
  const line: Record<string, unknown> = {
    parentUuid: ctx.prevUuid,
    isSidechain: false,
    userType: "external",
    cwd: ctx.cwd,
    sessionId: ctx.sessionId,
    version: "0.0.0",
    type: "assistant",
    message,
    uuid,
    timestamp: new Date(entryTs).toISOString(),
    permissionMode: ctx.permissionMode,
  };

  const toolUseIds: Array<{ refKey: string; resolvedId: string }> = [];
  for (const b of blocks) {
    if (b.type === "tool_use" && b.id) {
      toolUseIds.push({ refKey: b.id, resolvedId: b.id });
    }
  }

  return { jsonl: JSON.stringify(line), uuid, toolUseIds };
}

/**
 * Materialize a single ScenarioEntry into one or more JSONL lines.
 * The `ctx.prevUuid` is the UUID of the immediately preceding line (caller updates it).
 * An internal `counter` is threaded through to assign stable tool_use IDs.
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

  // Per-call counter - not shared across calls. The runner is responsible for
  // threading a shared counter if needed across entries. For Claude's wire
  // format, unique IDs per-call are sufficient because tool_use_ref resolution
  // uses the returned toolUseIds map.
  const counter = { n: 0 };
  const ts = ctx.baseTs;

  if (e.role === "user") {
    const content = e.content;
    const uuid = crypto.randomUUID();
    const line: Record<string, unknown> = {
      parentUuid: ctx.prevUuid,
      isSidechain: false,
      userType: "external",
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
      version: "0.0.0",
      type: "user",
      message: { role: "user", content },
      uuid,
      timestamp: new Date(ts).toISOString(),
      permissionMode: ctx.permissionMode,
    };
    if (e.isMeta === true) line.isMeta = true;
    return [{ jsonl: JSON.stringify(line), uuid, toolUseIds: [] }];
  }

  if (e.role === "assistant") {
    const blocks = (e.content ?? []) as ScenarioBlock[];
    const result = emitAssistantJsonl(blocks, "msg_scenario", ctx, ts, counter);
    return [result];
  }

  if (e.role === "assistant_split") {
    const lines = (e.lines ?? []) as Array<{ blocks: ScenarioBlock[] }>;
    const msgId = e.msg_id ?? "msg_scenario_split";
    const results: MaterializedScenarioLine[] = [];
    let prevUuid = ctx.prevUuid;
    for (let j = 0; j < lines.length; j++) {
      const subCtx: ScenarioMaterializeCtx = {
        ...ctx,
        prevUuid,
        baseTs: ts + j * 10,
      };
      const result = emitAssistantJsonl(lines[j].blocks, msgId, subCtx, ts + j * 10, counter);
      prevUuid = result.uuid;
      results.push(result);
    }
    return results;
  }

  return [];
}
