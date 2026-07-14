import { readToolLogEntries } from "./session-store.js";

export function findBatchDecision(
  sessionDir: string,
  allIds: string[],
): {
  decision: "allow" | "deny";
  reason: string;
  gate: string;
  toolUseId: string;
  batchPosition?: number;
  batchSize?: number;
} | null {
  const idSet = new Set(allIds);
  const entries = readToolLogEntries(sessionDir, 200);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e.toolUseId || !idSet.has(e.toolUseId)) continue;
    // Skip batch-sibling entries - they mirror the leader and their reason
    // is already prefixed with "Error in parallel tool call: ". Returning
    // theirs would cause triple-prefix on 3+ member batches.
    if (e.gate === "batch-sibling") continue;
    // Note: PostToolUse and PostToolUseFailure entries don't set `toolUseId`,
    // so the idSet guard above already excludes them - no explicit gate
    // filter needed. (post-tool-use.ts:23 gate is "post-tool-use";
    // post-tool-use-failure.ts:36 gate is "system".)
    return {
      decision: e.status === "allowed" ? "allow" : "deny",
      reason: e.reason ?? "Batch member decision",
      gate: e.gate,
      toolUseId: e.toolUseId,
      batchPosition: e.batchPosition,
      batchSize: e.batchSize,
    };
  }
  return null;
}
