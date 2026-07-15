import type { CanonicalToolCall } from "../../src/adapter/types.js";
import { recognizeMcp } from "./recognize-mcp.js";
import { extractApplyPatchPaths } from "./apply-patch-parser.js";

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
  write_file: "Write",
};

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
  if (aliased === "Agent" && rawName === "spawn_agent") {
    return { toolName: "Agent", toolInput: normalizeSpawnAgentInput(rawInput) };
  }
  if (aliased === "TaskOutput" && rawName === "wait_agent") {
    return { toolName: "TaskOutput", toolInput: normalizeWaitAgentInput(rawInput) };
  }
  return { toolName: aliased ?? rawName, toolInput: rawInput };
}
