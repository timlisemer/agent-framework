/**
 * Transcript line classifier for replay.
 *
 * Classifies each JSONL line into the hook that should fire,
 * following strict priority order. Key insight: check for tool_use
 * blocks FIRST regardless of stop_reason, since some lines have
 * stop_reason:null WITH tool_use blocks (final streaming chunk).
 *
 * @module test-harness/lib/classifier
 */

/**
 * Classification result for a single transcript line.
 */
export type LineClassification =
  | { kind: "skip" }
  | { kind: "user-prompt-submit"; prompt: string }
  | { kind: "pre-tool-use"; blocks: Array<{ id: string; name: string; input: unknown }> }
  | { kind: "post-tool-use"; results: Array<{ tool_use_id: string; content: unknown }> }
  | { kind: "stop-response-check" };

/**
 * Metadata-only line types that produce no hook invocation.
 */
export const SKIP_TYPES = new Set([
  "permission-mode",
  "file-history-snapshot",
  "attachment",
  "system",
]);

/**
 * Classify a single transcript line into the hook that should fire.
 *
 * Priority order:
 * 1. Metadata types -> skip
 * 2. User + isMeta -> skip
 * 3. User + tool_result content -> post-tool-use
 * 4. User + text content -> user-prompt-submit
 * 5. Assistant + tool_use blocks (ANY stop_reason) -> pre-tool-use
 * 6. Assistant + end_turn + no tool_use + real stop -> stop-response-check
 * 7. Assistant + null stop_reason + no tool_use -> skip (streaming chunk)
 * 8. Assistant + thinking-only -> skip
 */
export function classifyLine(
  parsed: Record<string, unknown>,
  lines: Record<string, unknown>[],
  lineIndex: number,
): LineClassification {
  const type = parsed.type as string | undefined;

  // Priority 1: metadata types
  if (type && SKIP_TYPES.has(type)) {
    return { kind: "skip" };
  }

  // Priority 2: system-injected user messages
  if (type === "user" && parsed.isMeta === true) {
    return { kind: "skip" };
  }

  if (type === "user") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;

    // Priority 3: tool_result content blocks
    if (Array.isArray(content)) {
      const toolResults = content.filter(
        (block: Record<string, unknown>) => block.type === "tool_result"
      );
      if (toolResults.length > 0) {
        return {
          kind: "post-tool-use",
          results: toolResults.map((r: Record<string, unknown>) => ({
            tool_use_id: r.tool_use_id as string,
            content: r.content,
          })),
        };
      }
    }

    // Priority 4: real user text prompt
    if (typeof content === "string" && content.length > 0) {
      return { kind: "user-prompt-submit", prompt: content };
    }

    // User message with array content but no tool_results (e.g. text blocks)
    if (Array.isArray(content)) {
      const textBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === "text"
      );
      if (textBlocks.length > 0) {
        const prompt = textBlocks
          .map((b: Record<string, unknown>) => b.text as string)
          .join("\n");
        if (prompt.length > 0) {
          return { kind: "user-prompt-submit", prompt };
        }
      }
    }

    return { kind: "skip" };
  }

  if (type === "assistant") {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const stopReason = message?.stop_reason ?? parsed.stop_reason;

    // Priority 5: tool_use blocks — check FIRST regardless of stop_reason
    if (Array.isArray(content)) {
      const toolUseBlocks = content.filter(
        (block: Record<string, unknown>) => block.type === "tool_use"
      );
      if (toolUseBlocks.length > 0) {
        return {
          kind: "pre-tool-use",
          blocks: toolUseBlocks.map((b: Record<string, unknown>) => ({
            id: b.id as string,
            name: b.name as string,
            input: b.input,
          })),
        };
      }
    }

    // Priority 6: real stop point
    if (stopReason === "end_turn") {
      if (isRealStop(lines, lineIndex)) {
        return { kind: "stop-response-check" };
      }
    }

    // Priority 7 & 8: streaming chunk, thinking-only — skip
    return { kind: "skip" };
  }

  return { kind: "skip" };
}

/**
 * Look-ahead to determine if an end_turn assistant line is a real stop.
 *
 * If the next line is also type:"assistant" with the same message.id,
 * this is a streaming chunk, not a real stop point.
 */
export function isRealStop(
  lines: Record<string, unknown>[],
  lineIndex: number,
): boolean {
  const current = lines[lineIndex];
  const currentMessage = current?.message as Record<string, unknown> | undefined;
  const currentId = currentMessage?.id;

  if (lineIndex + 1 < lines.length) {
    const next = lines[lineIndex + 1];
    if (next?.type === "assistant") {
      const nextMessage = next.message as Record<string, unknown> | undefined;
      const nextId = nextMessage?.id;
      if (currentId && nextId && currentId === nextId) {
        return false;
      }
    }
  }

  return true;
}

export interface BatchGroup {
  lineIndices: number[];
  toolUseIds: string[];
  toolNames: string[];
}

/**
 * Detect all parallel batches in a transcript.
 * Returns a Map from tool_use_id to its BatchGroup (only for batches of size >= 2).
 */
export function detectBatches(lines: Record<string, unknown>[]): Map<string, BatchGroup> {
  const result = new Map<string, BatchGroup>();

  // Collect runs of consecutive pre-tool-use lines (skipping skip lines between them)
  let i = 0;
  while (i < lines.length) {
    const classification = classifyLine(lines[i], lines, i);
    if (classification.kind !== "pre-tool-use") {
      i++;
      continue;
    }

    // Start of a potential batch
    const run: Array<{ lineIndex: number; blocks: Array<{ id: string; name: string }> }> = [];
    run.push({ lineIndex: i, blocks: classification.blocks.map((b) => ({ id: b.id, name: b.name })) });

    let j = i + 1;
    while (j < lines.length) {
      const nextClassification = classifyLine(lines[j], lines, j);
      if (nextClassification.kind === "skip") {
        j++;
        continue;
      }
      if (nextClassification.kind === "pre-tool-use") {
        run.push({ lineIndex: j, blocks: nextClassification.blocks.map((b) => ({ id: b.id, name: b.name })) });
        j++;
        continue;
      }
      break;
    }

    if (run.length >= 2) {
      const lineIndices: number[] = [];
      const toolUseIds: string[] = [];
      const toolNames: string[] = [];
      for (const entry of run) {
        for (const block of entry.blocks) {
          lineIndices.push(entry.lineIndex);
          toolUseIds.push(block.id);
          toolNames.push(block.name);
        }
      }
      const group: BatchGroup = { lineIndices, toolUseIds, toolNames };
      for (const id of toolUseIds) {
        result.set(id, group);
      }
    }

    i = j;
  }

  return result;
}

/**
 * Extract the working directory from transcript lines.
 *
 * Scans past line 0 since permission-mode lines have no cwd field.
 * Returns the first cwd found, or undefined if none exists.
 */
export function extractCwd(lines: Record<string, unknown>[]): string | undefined {
  for (const line of lines) {
    if (typeof line.cwd === "string" && line.cwd.length > 0) {
      return line.cwd;
    }
  }
  return undefined;
}
