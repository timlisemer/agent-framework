import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  FrameworkPermissionRequestHookInput,
  FrameworkPostToolUseFailureHookInput,
  FrameworkPostToolUseHookInput,
  FrameworkPreToolUseHookInput,
  FrameworkStopHookInput,
  FrameworkUserPromptSubmitHookInput,
} from "../../../src/hooks/types.js";

interface CodexBaseInput {
  session_id?: string;
  sessionId?: string;
  transcript_path?: string | null;
  transcriptPath?: string | null;
  cwd?: string;
  permission_mode?: string;
  permissionMode?: string;
  collaboration_mode?: CodexCollaborationModeValue;
  collaborationMode?: CodexCollaborationModeValue;
  collaboration_mode_kind?: CodexCollaborationModeValue;
  collaborationModeKind?: CodexCollaborationModeValue;
  sandbox_mode?: string;
}

type CodexCollaborationModeValue =
  | string
  | { mode?: unknown; kind?: unknown }
  | null
  | undefined;

export interface CodexToolInput extends CodexBaseInput {
  tool_name?: string;
  toolName?: string;
  tool_input?: unknown;
  toolInput?: unknown;
  input?: unknown;
  tool_use_id?: string;
  toolUseId?: string;
  tool_response?: unknown;
  toolResponse?: unknown;
}

export interface CodexFailureInput extends CodexToolInput {
  error?: string;
  is_interrupt?: boolean;
  isInterrupt?: boolean;
}

export interface CodexSessionStartInput extends CodexBaseInput {
  source: "startup" | "resume" | "clear" | "compact";
}

export interface CodexPromptInput extends CodexBaseInput {
  prompt: string;
}

export interface CodexStopInput extends CodexBaseInput {
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

export function initCodexEnv(input: CodexBaseInput): void {
  process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
  if (input.cwd) process.env.AGENT_FRAMEWORK_PROJECT_DIR = input.cwd;
}

export function transcriptPath(input: CodexBaseInput): string {
  if (input.transcript_path) return input.transcript_path;
  if (input.transcriptPath) return input.transcriptPath;
  const dir = path.join(os.homedir(), ".agent-framework", "codex-transcripts");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId(input)}.jsonl`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  return file;
}

export function toPreToolUse(input: CodexToolInput): FrameworkPreToolUseHookInput {
  const toolName = input.tool_name ?? input.toolName ?? "unknown";
  return {
    session_id: sessionId(input),
    transcript_path: transcriptPath(input),
    cwd: input.cwd,
    permission_mode: input.permission_mode ?? input.permissionMode,
    collaboration_mode: codexCollaborationMode(input),
    tool_name: toolName,
    tool_input: input.tool_input ?? input.toolInput ?? input.input,
    tool_use_id: input.tool_use_id ?? input.toolUseId ?? `${toolName}-${Date.now()}`,
  };
}

export function toPostToolUse(input: CodexToolInput): FrameworkPostToolUseHookInput {
  return {
    ...toPreToolUse(input),
    tool_response: input.tool_response ?? input.toolResponse,
  };
}

export function toPostToolUseFailure(
  input: CodexFailureInput,
): FrameworkPostToolUseFailureHookInput {
  return {
    ...toPreToolUse(input),
    error: input.error ?? "Tool failed.",
    is_interrupt: input.is_interrupt ?? input.isInterrupt ?? false,
  };
}

export function toPermissionRequest(input: CodexToolInput): FrameworkPermissionRequestHookInput {
  return toPreToolUse(input);
}

export function toUserPromptSubmit(input: CodexPromptInput): FrameworkUserPromptSubmitHookInput {
  return {
    session_id: sessionId(input),
    transcript_path: transcriptPath(input),
    cwd: input.cwd,
    permission_mode: input.permission_mode ?? input.permissionMode,
    collaboration_mode: codexCollaborationMode(input),
    prompt: input.prompt,
  };
}

export function toStop(input: CodexStopInput): FrameworkStopHookInput {
  return {
    session_id: sessionId(input),
    transcript_path: transcriptPath(input),
    cwd: input.cwd,
    permission_mode: input.permission_mode ?? input.permissionMode,
    collaboration_mode: codexCollaborationMode(input),
    stop_hook_active: input.stop_hook_active,
    last_assistant_message: input.last_assistant_message,
  };
}

export function sessionId(input: CodexBaseInput): string {
  return input.session_id ?? input.sessionId ?? "unknown";
}

function normalizeCodexCollaborationModeValue(
  value: CodexCollaborationModeValue,
): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value.mode === "string") return value.mode;
  if (value && typeof value.kind === "string") return value.kind;
  return undefined;
}

export function codexCollaborationMode(input: CodexBaseInput): string | undefined {
  return normalizeCodexCollaborationModeValue(input.collaboration_mode) ??
    normalizeCodexCollaborationModeValue(input.collaborationMode) ??
    normalizeCodexCollaborationModeValue(input.collaboration_mode_kind) ??
    normalizeCodexCollaborationModeValue(input.collaborationModeKind);
}
