export interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  delivery_id?: string;
  cwd?: string;
  permission_mode?: string;
  collaboration_mode?: string;
}

export interface FrameworkSessionStartHookInput extends BaseHookInput {
  source: "startup" | "resume" | "compact" | "clear";
}

export interface FrameworkPreToolUseHookInput extends BaseHookInput {
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

export interface FrameworkPostToolUseHookInput extends BaseHookInput {
  tool_name: string;
  tool_input: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
}

export interface FrameworkPostToolUseFailureHookInput extends BaseHookInput {
  tool_name: string;
  tool_input?: unknown;
  tool_use_id?: string;
  error: string;
  is_interrupt: boolean;
}

export interface FrameworkStopHookInput extends BaseHookInput {
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
}

export interface FrameworkUserPromptSubmitHookInput extends BaseHookInput {
  prompt: string;
}

export interface FrameworkPermissionRequestHookInput extends BaseHookInput {
  tool_name: string;
  tool_input: unknown;
  tool_use_id?: string;
}
