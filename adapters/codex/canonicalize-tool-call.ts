import type { CanonicalToolCall } from "../../src/adapter/types.js";
import { recognizeMcp } from "./recognize-mcp.js";
import { extractApplyPatchPaths } from "./apply-patch-parser.js";

const ALIAS: Readonly<Record<string, string>> = { apply_patch: "Edit", exec_command: "Bash" };

function normalizeExecCommandInput(rawInput: unknown): unknown {
  const input = rawInput as { command?: unknown; args?: unknown[] } | null | undefined;
  if (!input) return rawInput;
  // exec_command uses { command, args } shape; Bash uses { command: string }
  if (Array.isArray(input.args)) {
    const cmd = [input.command, ...input.args].filter(Boolean).join(" ");
    return { command: cmd };
  }
  return { command: String(input.command ?? "") };
}

export function canonicalizeToolCall(rawName: string, rawInput: unknown): CanonicalToolCall {
  const mcp = recognizeMcp(rawName);
  if (mcp) return { toolName: `mcp-${mcp}`, toolInput: rawInput };

  const aliased = ALIAS[rawName];
  if (aliased === "Edit" && rawName === "apply_patch") {
    const paths = extractApplyPatchPaths(rawInput);
    return { toolName: "Edit", toolInput: { file_path: paths[0], file_paths: paths } };
  }
  if (aliased === "Bash" && rawName === "exec_command") {
    return { toolName: "Bash", toolInput: normalizeExecCommandInput(rawInput) };
  }
  return { toolName: aliased ?? rawName, toolInput: rawInput };
}
