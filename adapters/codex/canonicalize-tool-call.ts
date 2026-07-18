import type { CanonicalToolCall } from "../../src/adapter/types.js";
import { recognizeMcp } from "./recognize-mcp.js";
import { extractApplyPatchPaths } from "./apply-patch-parser.js";
import { serializeShellCommandTokens } from "../../src/utils/shell-command-parser.js";
import { recordFromUnknown } from "../../src/utils/output.js";

const ALIAS: Readonly<Record<string, string>> = {
  apply_patch: "Edit",
  close_agent: "CloseAgent",
  edit_file: "Edit",
  exec_command: "Bash",
  list_mcp_resources: "ListMcpResources",
  read_mcp_resource: "ReadMcpResource",
  resume_agent: "ResumeAgent",
  send_input: "SendInput",
  spawn_agent: "Agent",
  tool_search: "ToolSearch",
  wait: "Wait",
  wait_agent: "TaskOutput",
  write_stdin: "Bash",
  write_file: "Write",
};

function normalizeExecCommandInput(rawInput: unknown): unknown {
  const input = rawInput as { command?: unknown; cmd?: unknown; args?: unknown[] } | null | undefined;
  if (!input) return rawInput;
  // exec_command uses { command, args } shape; Bash uses { command: string }
  const command = String(input.command ?? input.cmd ?? "");
  if (Array.isArray(input.args)) {
    return {
      command: serializeShellCommandTokens([
        command,
        ...input.args.map((argument) => String(argument)),
      ]),
    };
  }
  return { command };
}

function normalizeWriteStdinInput(rawInput: unknown): unknown {
  const input = recordFromUnknown(rawInput);
  return {
    command: typeof input.chars === "string" ? input.chars : "",
    ...(typeof input.session_id === "number" || typeof input.session_id === "string"
      ? { continuation_session_id: input.session_id }
      : {}),
  };
}

function normalizeSpawnAgentInput(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return rawInput;
  const input = rawInput as Record<string, unknown>;
  const rawAgentType = input.agent_type ?? input.subagent_type;
  const agentType =
    typeof rawAgentType === "string" && rawAgentType.length > 0
      ? rawAgentType
      : "default";
  return {
    ...input,
    subagent_type: agentType,
  };
}

function normalizeWaitAgentInput(rawInput: unknown): unknown {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) return rawInput;
  const input = rawInput as Record<string, unknown>;
  const rawTargets = input.targets;
  const targets = Array.isArray(rawTargets)
    ? rawTargets.filter((target): target is string => typeof target === "string")
    : typeof input.target === "string"
      ? [input.target]
      : typeof input.agent_id === "string"
        ? [input.agent_id]
        : typeof input.agentId === "string"
          ? [input.agentId]
          : undefined;

  if (!targets) return rawInput;
  return {
    ...input,
    targets,
  };
}

export function canonicalizeToolCall(rawName: string, rawInput: unknown): CanonicalToolCall {
  const codexName = rawName.startsWith("functions.")
    ? rawName.slice("functions.".length)
    : rawName;
  const mcp = recognizeMcp(codexName);
  if (mcp) return { toolName: `mcp-${mcp}`, toolInput: rawInput };

  const aliased = ALIAS[codexName];
  if (aliased === "Edit" && codexName === "apply_patch") {
    const paths = extractApplyPatchPaths(rawInput);
    return { toolName: "Edit", toolInput: { file_path: paths[0], file_paths: paths } };
  }
  if (aliased === "Bash" && codexName === "exec_command") {
    return { toolName: "Bash", toolInput: normalizeExecCommandInput(rawInput) };
  }
  if (aliased === "Bash" && codexName === "write_stdin") {
    return { toolName: "Bash", toolInput: normalizeWriteStdinInput(rawInput) };
  }
  if (aliased === "Agent" && codexName === "spawn_agent") {
    return { toolName: "Agent", toolInput: normalizeSpawnAgentInput(rawInput) };
  }
  if (aliased === "TaskOutput" && codexName === "wait_agent") {
    return { toolName: "TaskOutput", toolInput: normalizeWaitAgentInput(rawInput) };
  }
  return { toolName: aliased ?? rawName, toolInput: rawInput };
}
