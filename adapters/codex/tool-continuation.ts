import type {
  AdapterToolContinuation,
  CanonicalToolCall,
} from "../../src/adapter/types.js";
import { recognizeCanonicalMcpToolName } from "../../src/adapter/mcp-wire.js";
import { mcpTimeoutForTool } from "../../src/mcp/timeout.js";

const YIELDED_CELL_MARKER_RE = /^Script running with cell ID ([A-Za-z0-9][A-Za-z0-9._:-]*)$/;

export function toolResultMayRequireContinuation(
  call: CanonicalToolCall,
): boolean {
  return recognizeCanonicalMcpToolName(call.toolName) !== null;
}

export function continuationAfterToolResult(
  call: CanonicalToolCall,
  toolResponse: unknown,
): AdapterToolContinuation | null {
  const cellId = yieldedCellId(toolResponse);
  if (!cellId) return null;
  const canonicalMcp = recognizeCanonicalMcpToolName(call.toolName);
  if (canonicalMcp) {
    return waitContinuation(cellId, mcpTimeoutForTool(canonicalMcp));
  }
  if (call.toolName !== "Wait") return null;
  const input = call.toolInput as { yield_time_ms?: unknown } | null | undefined;
  return typeof input?.yield_time_ms === "number"
    ? waitContinuation(cellId, input.yield_time_ms)
    : null;
}

export function continuationAfterToolFailure(
  call: CanonicalToolCall,
  _error: string,
  isInterrupt: boolean,
): AdapterToolContinuation | null {
  if (isInterrupt || call.toolName !== "Wait") return null;
  const input = call.toolInput as {
    cell_id?: unknown;
    yield_time_ms?: unknown;
  } | null | undefined;
  return typeof input?.cell_id === "string" &&
    typeof input.yield_time_ms === "number"
    ? waitContinuation(input.cell_id, input.yield_time_ms)
    : null;
}

function waitContinuation(
  cellId: string,
  yieldTimeMs: number,
): AdapterToolContinuation {
  return {
    toolName: "Wait",
    toolInput: {
      cell_id: cellId,
      yield_time_ms: yieldTimeMs,
    },
  };
}

function yieldedCellId(value: unknown): string | null {
  if (typeof value === "string") {
    return YIELDED_CELL_MARKER_RE.exec(value.trim())?.[1] ?? null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    if (!block || typeof block !== "object" || Array.isArray(block)) continue;
    const textBlock = block as { type?: unknown; text?: unknown };
    if (textBlock.type !== "text" || typeof textBlock.text !== "string") continue;
    const cellId = YIELDED_CELL_MARKER_RE.exec(textBlock.text.trim())?.[1];
    if (cellId) return cellId;
  }
  return null;
}
