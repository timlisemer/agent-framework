import type { AiMetadata } from "../../src/ai-protocol/index.js";
import type { AiErrorInfo, AiToolOutputBlock } from "../../src/ai-protocol/index.js";
import { buildAgentFrameworkToolLogUiMetadata } from "../../src/utils/agent-framework-tool-log.js";
import { isEditToolName } from "../../src/utils/edit-tools.js";
import { hashSha256Prefix, stableJsonStringify } from "../../src/utils/hash-utils.js";
import { trimmedStringField } from "../../src/utils/output.js";
import type { ToolLogEntry } from "../../src/utils/tool-log-types.js";
import { canonicalizeToolCall } from "./canonicalize-tool-call.js";
import { mcpWireName, recognizeMcpServerTool } from "./recognize-mcp.js";
import {
  codexToolLogCanonicalInput,
  extractCodexFileChangePaths,
  extractCodexToolPaths,
  interpretCodexToolOutputPayload,
  isCodexFailureStatus,
  normalizeCodexToolName,
  parseCodexToolInput,
} from "./tool-payload.js";

export type CodexToolIdentity = {
  rawToolName: string;
  rawToolInput: unknown;
  canonicalToolName: string;
  canonicalToolInput: unknown;
  signature: string;
};

export type CodexRuntimeToolHelpers = {
  normalizeToolName(payload: Record<string, unknown>): string;
  parseToolInput(payload: Record<string, unknown>): unknown;
  interpretToolOutput(payload: Record<string, unknown>, outputValue?: unknown): {
    output: AiToolOutputBlock[];
    error: AiErrorInfo | null;
  };
  extractFileChangePaths(item: Record<string, unknown>): string[];
  isFailureStatus(status: string | null | undefined): boolean;
  commandActionSummary(value: unknown): string | null;
  itemMetadata(item: Record<string, unknown>, itemType: string | null, id: string): AiMetadata;
  itemToolIdentity(itemType: string | null, item: Record<string, unknown>): CodexToolIdentity;
  toolIdentity(rawToolName: string, rawToolInput: unknown): CodexToolIdentity;
  toolIdentityPaths(identity: CodexToolIdentity): string[];
  isFileMutationTool(tool: string): boolean;
  syntheticItemRef(itemType: string | null, item: Record<string, unknown>): string;
};

export function codexItemMetadata(
  item: Record<string, unknown>,
  itemType: string | null,
  id: string
): AiMetadata {
  const identity = codexItemToolIdentity(itemType, item);
  const metadata: AiMetadata = {
    provider: "codex",
    providerItemId: id,
    providerItemType: itemType ?? "unknown",
    agentFrameworkCanonicalToolName: identity.canonicalToolName,
    agentFrameworkToolSignature: identity.signature,
  };
  const status = trimmedStringField(item, "status");
  if (status) metadata.providerItemStatus = status;
  const callId = trimmedStringField(item, "call_id");
  if (callId) metadata.providerToolCallId = callId;
  const actionSummary = codexCommandActionSummary(item.commandActions ?? item.actions);
  if (actionSummary) metadata.actionSummary = actionSummary;
  return metadata;
}

export function codexItemToolIdentity(itemType: string | null, item: Record<string, unknown>): CodexToolIdentity {
  switch (itemType) {
    case "command_execution":
      return codexToolIdentity("exec_command", { command: trimmedStringField(item, "command") ?? "" });
    case "mcp_tool_call": {
      const server = trimmedStringField(item, "server");
      const tool = trimmedStringField(item, "tool");
      const canonicalMcp = server && tool ? recognizeMcpServerTool(server, tool) : null;
      const rawName = canonicalMcp
        ? mcpWireName(canonicalMcp)
        : server && tool ? `mcp__${server}__${tool}` : "mcp_tool";
      return codexToolIdentity(rawName, item.arguments ?? {});
    }
    case "file_change": {
      const paths = extractCodexFileChangePaths(item);
      return codexToolIdentity("Edit", { file_path: paths[0] ?? "", file_paths: paths });
    }
    case "web_search":
      return codexToolIdentity("WebSearch", { query: trimmedStringField(item, "query") ?? "" });
    case "function_call":
    case "custom_tool_call":
      return codexToolIdentity(normalizeCodexToolName(item), parseCodexToolInput(item));
    default:
      return codexToolIdentity(itemType ?? "runtime_item", stableCodexItemPayload(itemType, item));
  }
}

export function codexToolLogIdentity(entry: ToolLogEntry): CodexToolIdentity {
  return codexToolIdentity(entry.tool, codexToolLogCanonicalInput(entry));
}

export function codexToolIdentity(rawToolName: string, rawToolInput: unknown): CodexToolIdentity {
  const canonical = canonicalizeToolCall(rawToolName, rawToolInput);
  return {
    rawToolName,
    rawToolInput,
    canonicalToolName: canonical.toolName,
    canonicalToolInput: canonical.toolInput,
    signature: toolIdentitySignature(canonical.toolName, canonical.toolInput),
  };
}

export function codexToolIdentityPaths(identity: CodexToolIdentity): string[] {
  return identity.canonicalToolInput && typeof identity.canonicalToolInput === "object" && !Array.isArray(identity.canonicalToolInput)
    ? extractCodexToolPaths(identity.canonicalToolInput)
    : [];
}

export function codexToolLogMetadata(entry: ToolLogEntry): AiMetadata {
  const identity = codexToolLogIdentity(entry);
  return buildAgentFrameworkToolLogUiMetadata({
    entry,
    provider: "codex",
    providerItemId: entry.toolUseId ?? `${entry.tool}:${entry.ts}`,
    providerItemType: "agent_framework_tool_log",
    canonicalToolName: identity.canonicalToolName,
    toolSignature: identity.signature,
  });
}

export function codexToolLogToolName(entry: ToolLogEntry): string {
  return entry.tool || "tool";
}

export function codexToolLogInput(entry: ToolLogEntry): unknown {
  const input: Record<string, unknown> = {
    tool: entry.tool,
    gate: entry.gate,
    status: entry.status,
  };
  if (entry.cmd) input.command = entry.cmd;
  if (entry.path) input.path = entry.path;
  if (entry.paths?.length) input.files = entry.paths.join(", ");
  if (entry.reason) input.reason = entry.reason;
  if (typeof entry.batchPosition === "number") input.batchPosition = entry.batchPosition;
  if (typeof entry.batchSize === "number") input.batchSize = entry.batchSize;
  return input;
}

export function codexCommandActionSummary(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const lines = value
    .map(codexCommandActionLine)
    .filter((line): line is string => Boolean(line));
  return lines.length > 0 ? lines.join("\n") : null;
}

export function isCodexFileMutationTool(tool: string): boolean {
  return isEditToolName(tool) || tool === "apply_patch";
}

export function syntheticCodexItemRef(itemType: string | null, item: Record<string, unknown>): string {
  const stableItem = stableCodexItemPayload(itemType, item);
  const canonical = stableJsonStringify(stableItem);
  const hash = hashSha256Prefix(canonical, 12);
  return `${itemType ?? "item"}:${hash}`;
}

export const codexRuntimeToolHelpers: CodexRuntimeToolHelpers = {
  normalizeToolName: normalizeCodexToolName,
  parseToolInput: parseCodexToolInput,
  interpretToolOutput: interpretCodexToolOutputPayload,
  extractFileChangePaths: extractCodexFileChangePaths,
  isFailureStatus: isCodexFailureStatus,
  commandActionSummary: codexCommandActionSummary,
  itemMetadata: codexItemMetadata,
  itemToolIdentity: codexItemToolIdentity,
  toolIdentity: codexToolIdentity,
  toolIdentityPaths: codexToolIdentityPaths,
  isFileMutationTool: isCodexFileMutationTool,
  syntheticItemRef: syntheticCodexItemRef,
};

function toolIdentitySignature(canonicalToolName: string, canonicalToolInput: unknown): string {
  const paths = canonicalToolInput && typeof canonicalToolInput === "object" && !Array.isArray(canonicalToolInput)
    ? extractCodexToolPaths(canonicalToolInput)
    : [];
  if (paths.length > 0 && isCodexFileMutationTool(canonicalToolName)) {
    return `file_change:${paths.join("|")}`;
  }
  return stableJsonStringify({ toolName: canonicalToolName, toolInput: canonicalToolInput ?? {} });
}

function codexCommandActionLine(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const action = value as Record<string, unknown>;
  const type = trimmedStringField(action, "type") ?? "action";
  const pathValue = trimmedStringField(action, "path") ?? trimmedStringField(action, "file_path");
  const name = trimmedStringField(action, "name");
  const query = trimmedStringField(action, "query") ?? trimmedStringField(action, "pattern");
  const target = pathValue ?? name;
  switch (type) {
    case "read":
      return `Read ${target ?? "file"}`;
    case "search":
    case "grep":
      return `Search ${query ? JSON.stringify(query) : "text"}${target ? ` in ${target}` : ""}`;
    case "list":
    case "ls":
      return `List ${target ?? "directory"}`;
    case "glob":
      return `Glob ${query ?? target ?? "files"}`;
    case "mcp": {
      const server = trimmedStringField(action, "server");
      const tool = trimmedStringField(action, "tool");
      return `MCP ${server && tool ? `${server}::${tool}` : target ?? "tool"}`;
    }
    default:
      return `${titleCase(type)} ${target ?? query ?? ""}`.trim();
  }
}

function titleCase(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function stableCodexItemPayload(itemType: string | null, item: Record<string, unknown>): Record<string, unknown> {
  switch (itemType) {
    case "command_execution":
      return { type: itemType, command: item.command };
    case "mcp_tool_call":
      return { type: itemType, server: item.server, tool: item.tool, arguments: item.arguments };
    case "file_change":
      return { type: itemType, changes: item.changes };
    case "web_search":
      return { type: itemType, query: item.query };
    default: {
      const stable: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(item)) {
        if (["status", "text", "summary", "aggregated_output", "result", "error", "progress"].includes(key)) continue;
        stable[key] = value;
      }
      return stable;
    }
  }
}
