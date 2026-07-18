import { extractFilePaths, extractPathOrCmd } from "../rules/utils.js";
import type { ScenarioSnapshot } from "../scenario/protocol/snapshot.js";
import type { ToolLogEntry } from "../utils/tool-log-types.js";

/** Project canonical tool snapshots into the shared rule/tool-log vocabulary. */
export function canonicalToolHistory(snapshot: ScenarioSnapshot): ToolLogEntry[] {
  return snapshot.toolCalls.map((tool) => {
    const pathOrCommand = extractPathOrCmd(tool.input);
    return {
      ts: Date.parse(tool.updatedAt),
      tool: tool.name,
      toolUseId: tool.id,
      path: pathOrCommand.path,
      paths: extractFilePaths(tool.name, tool.input),
      cmd: pathOrCommand.cmd,
      status: tool.status === "completed"
        ? "allowed"
        : tool.status === "denied" ? "denied" : tool.status,
      gate: tool.authorization.policy === "pending" ? "scenario-runtime" : "canonical-policy",
      ...(tool.authorization.reason ? { reason: tool.authorization.reason } : {}),
      ms: Math.max(0, Date.parse(tool.updatedAt) - Date.parse(tool.createdAt)),
    };
  });
}
