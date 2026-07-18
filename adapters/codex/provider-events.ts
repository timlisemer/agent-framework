import type { ScenarioCommandPayload } from "../../src/scenario/protocol/commands.js";
import { toJsonValue as jsonValue } from "../../src/scenario/protocol/common.js";
import { digestScenarioValue } from "../../src/scenario/protocol/digest.js";
import {
  errorMessage,
  isRecord,
  optionalNumber,
  recordFromUnknown,
} from "../../src/utils/output.js";
import { canonicalizeToolCall } from "./canonicalize-tool-call.js";
import { recognizeMcpServerTool } from "./recognize-mcp.js";
import { mapCodexTokenUsage } from "./usage.js";

export function mapCodexProviderEvent(event: unknown, turnId: string): ScenarioCommandPayload[] {
  if (!isRecord(event)) return [];
  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    return [{ type: "providerStateObserved", data: { nativeSessionId: event.thread_id } }];
  }
  if (event.type === "turn.completed") {
    return [{
      type: "providerStateObserved",
      data: {
        usage: jsonValue(mapCodexTokenUsage(event.usage, optionalNumber)),
      },
    }];
  }
  if (event.type === "turn.failed") {
    return [{ type: "runtimeErrorObserved", data: { message: errorMessage(event.error, "Runtime turn failed") } }];
  }
  if (event.type === "error") {
    return [{ type: "runtimeErrorObserved", data: { message: errorMessage(event.message, "Runtime stream error") } }];
  }
  return mapCodexStructuredEvent(event, turnId);
}

export function mapCodexStructuredEvent(raw: Record<string, unknown>, turnId: string): ScenarioCommandPayload[] {
  if (!["item.started", "item.updated", "item.completed"].includes(String(raw.type))) return [];
  if (!isRecord(raw.item)) return [];
  const item = raw.item;
  const phase = raw.type === "item.started" ? "started" : raw.type === "item.completed" ? "completed" : "updated";
  if (item.type === "reasoning" && typeof item.text === "string") {
    return [{ type: "providerStateObserved", data: { lastReasoning: item.text } }];
  }
  if (item.type === "todo_list") {
    return [{ type: "providerStateObserved", data: { todoList: jsonValue(item.items ?? []) } }];
  }
  if (item.type === "error" && typeof item.message === "string") {
    return [{ type: "runtimeErrorObserved", data: { message: item.message } }];
  }
  const id = typeof item.id === "string" && item.id.length > 0 ? item.id : null;
  if (!id) return [];
  if (item.type === "agent_message" && typeof item.text === "string") {
    return [{
      type: phase === "completed" ? "assistantMessageCompleted" : "assistantMessageObserved",
      messageId: id,
      turnId,
      content: item.text,
      contentDigest: digestScenarioValue(item.text),
    }];
  }
  const tool = codexToolObservation(item);
  if (!tool) return [];
  if (phase === "started") {
    const canonical = canonicalizeToolCall(tool.name, tool.input);
    const input = jsonValue(canonical.toolInput);
    return [{
      type: "toolExecutionObserved",
      toolCallId: id,
      turnId,
      name: canonical.toolName,
      input,
      inputDigest: digestScenarioValue(input),
    }];
  }
  if (phase === "updated") {
    // Codex SDK tool updates expose cumulative aggregates, not append-only deltas.
    // Publish the aggregate once on the terminal event.
    return [];
  }
  if (tool.failed) {
    return [{
      type: "toolFailed",
      toolCallId: id,
      error: tool.error ?? "Tool execution failed",
      ...(tool.output === undefined ? {} : { output: jsonValue(tool.output) }),
    }];
  }
  return [{
    type: "toolCompleted",
    toolCallId: id,
    ...(tool.output === undefined ? {} : { output: jsonValue(tool.output) }),
  }];
}

function codexToolObservation(item: Record<string, unknown>): {
  name: string;
  input: unknown;
  output?: unknown;
  failed: boolean;
  error?: string;
} | null {
  if (item.type === "command_execution") {
    return {
      name: "Bash",
      input: { command: item.command ?? "" },
      output: item.aggregated_output,
      failed: item.status === "failed" || (typeof item.exit_code === "number" && item.exit_code !== 0),
      ...(item.status === "failed" ? { error: "Command execution failed" } : {}),
    };
  }
  if (item.type === "file_change") {
    return { name: "apply_patch", input: { changes: item.changes ?? [] }, failed: item.status === "failed" };
  }
  if (item.type === "mcp_tool_call") {
    const toolError = recordFromUnknown(item.error);
    const server = String(item.server ?? "mcp");
    const tool = String(item.tool ?? "tool");
    const recognized = recognizeMcpServerTool(server, tool);
    return {
      name: recognized ? `mcp-${recognized}` : `${server}.${tool}`,
      input: item.arguments ?? null,
      output: item.result,
      failed: item.status === "failed" || item.error !== undefined,
      ...(typeof toolError.message === "string" ? { error: toolError.message } : {}),
    };
  }
  if (item.type === "web_search") {
    return { name: "WebSearch", input: { query: item.query ?? "" }, failed: false };
  }
  return null;
}
