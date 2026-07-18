import { errorMessage, trimmedStringField } from "../../src/utils/output.js";
import { outputBlocks } from "../../src/providers/provider-output.js";
import type {
  ProviderError,
  ProviderToolOutputBlock,
} from "../../src/providers/provider-contract.js";
import type { ToolLogEntry } from "../../src/utils/tool-log-types.js";

const SINGLE_PATH_KEYS = ["file_path", "path", "notebook_path"] as const;
const ARRAY_PATH_KEYS = ["file_paths", "paths", "files"] as const;

export function normalizeCodexToolName(payload: Record<string, unknown>): string {
  const name = typeof payload.name === "string" ? payload.name : "unknown";
  const namespace = typeof payload.namespace === "string" ? payload.namespace : "";
  return `${namespace}${name}`;
}

export function parseCodexToolInput(payload: Record<string, unknown>): unknown {
  const input = payload.input ?? payload.arguments;
  if (typeof input !== "string") return input ?? {};
  const trimmed = input.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return input;
  }
}

export function parseCodexToolObjectInput(payload: Record<string, unknown>): Record<string, unknown> {
  const input = parseCodexToolInput(payload);
  return input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
}

export function interpretCodexToolOutputPayload(
  payload: Record<string, unknown>,
  outputValue: unknown = payload.output
): { output: ProviderToolOutputBlock[]; error: ProviderError | null } {
  const output = outputBlocks(outputValue);
  const status = trimmedStringField(payload, "status");
  const failed = isCodexToolFailureStatus(status) || payload.error !== undefined;
  return {
    output,
    error: failed
      ? {
          code: "runtime_error",
          message: errorMessage(payload.error ?? payload.output ?? payload.result),
          recoverable: false,
        }
      : null,
  };
}

export function isCodexToolFailureStatus(status: string | null | undefined): boolean {
  return status === "failed" || status === "error";
}

export function extractCodexToolPaths(input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const raw = input as Record<string, unknown>;
  const paths: string[] = [];

  for (const key of SINGLE_PATH_KEYS) {
    const value = trimmedStringField(raw, key);
    if (value) paths.push(value);
  }

  for (const key of ARRAY_PATH_KEYS) {
    const value = raw[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string" && item.trim()) paths.push(item.trim());
    }
  }

  return canonicalizeCodexPaths(paths);
}

export function extractCodexFileChangePaths(item: Record<string, unknown>): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];
  return canonicalizeCodexPaths(changes.map((change) =>
    change && typeof change === "object"
      ? trimmedStringField(change as Record<string, unknown>, "path")
      : null
  ));
}

export function codexToolLogEntryMatchesToolCall(
  entry: ToolLogEntry,
  toolName: string,
  input: unknown
): boolean {
  const rawInput = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const hookToolName = codexHookToolName(toolName);
  if (entry.tool !== hookToolName && entry.tool !== toolName) return false;

  const command = codexShellCommand(toolName, rawInput);
  if (toolName === "exec_command" || toolName === "write_stdin" || entry.tool === "Bash" || entry.cmd) {
    return Boolean(command && entry.cmd && command === entry.cmd);
  }

  const inputPaths = extractCodexToolPaths(rawInput);
  const logPaths = canonicalizeCodexPaths([entry.path, ...(entry.paths ?? [])]);
  if (inputPaths.length > 0 || logPaths.length > 0) {
    return sameStringList(inputPaths, logPaths);
  }

  return true;
}

export function codexTranscriptToolLogMatchIsStable(toolName: string, input: unknown): boolean {
  return codexTranscriptToolLogIdentityKey(toolName, input) !== null;
}

export function codexTranscriptToolLogIdentityKey(toolName: string, input: unknown): string | null {
  const rawInput = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const hookToolName = codexHookToolName(toolName);
  const command = codexShellCommand(toolName, rawInput);
  if ((toolName === "exec_command" || toolName === "write_stdin" || hookToolName === "Bash") && command) {
    return `${hookToolName}:cmd:${command}`;
  }
  const paths = extractCodexToolPaths(rawInput);
  return paths.length > 0 ? `${hookToolName}:paths:${paths.join("\0")}` : null;
}

function canonicalizeCodexPaths(paths: readonly (string | null | undefined)[]): string[] {
  return [...new Set(paths
    .map((path) => typeof path === "string" ? path.trim() : "")
    .filter((path) => path.length > 0))]
    .sort();
}

function codexHookToolName(toolName: string): string {
  switch (toolName) {
    case "exec_command":
    case "write_stdin":
      return "Bash";
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "edit_file":
    case "apply_patch":
      return "Edit";
    default:
      return toolName;
  }
}

function codexShellCommand(toolName: string, input: Record<string, unknown>): string | null {
  return trimmedStringField(input, toolName === "write_stdin" ? "chars" : "command");
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
