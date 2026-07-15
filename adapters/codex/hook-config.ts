export const CODEX_TOOL_LIFECYCLE_MATCHER =
  "Read|Bash|apply_patch|edit_file|write_file|Edit|MultiEdit|Write|NotebookEdit|spawn_agent|send_input|resume_agent|wait|wait_agent|close_agent|mcp__.*";

export const CODEX_HOOK_EVENTS = [
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
] as const;

export type CodexHookEvent = typeof CODEX_HOOK_EVENTS[number];

interface CodexHookCommand {
  type: "command";
  command: string;
  statusMessage?: string;
  timeout?: number;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookCommand[];
}

interface CodexHookConfig {
  hooks: Partial<Record<CodexHookEvent, CodexHookGroup[]>>;
}

export const CODEX_HOOKS_CONFIG = {
  hooks: {
    SessionStart: [{
      matcher: "startup|resume|clear|compact",
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/session-start.js",
        statusMessage: "Initializing agent-framework",
      }],
    }],
    UserPromptSubmit: [{
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/user-prompt-submit.js",
        statusMessage: "Classifying user intent",
      }],
    }],
    PreToolUse: [{
      matcher: CODEX_TOOL_LIFECYCLE_MATCHER,
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/pre-tool-use.js",
        statusMessage: "Checking tool use",
      }],
    }],
    PermissionRequest: [{
      matcher: CODEX_TOOL_LIFECYCLE_MATCHER,
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/permission-request.js",
        statusMessage: "Checking permission request",
      }],
    }],
    PostToolUse: [{
      matcher: CODEX_TOOL_LIFECYCLE_MATCHER,
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/post-tool-use.js",
      }],
    }],
    PostToolUseFailure: [{
      matcher: CODEX_TOOL_LIFECYCLE_MATCHER,
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/post-tool-use-failure.js",
      }],
    }],
    Stop: [{
      hooks: [{
        type: "command",
        command: "node $AGENT_FRAMEWORK_ROOT/dist/adapters/codex/hooks/stop-response-check.js",
        timeout: 30,
      }],
    }],
  },
} satisfies CodexHookConfig;
