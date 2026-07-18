import { digestCanonicalJson } from "../../src/scenario/protocol/digest.js";
import {
  CODEX_HOOK_EVENTS,
  type CodexHookEvent,
} from "./hook-config.js";

export const CODEX_HOOK_TRUST_BEGIN = "# BEGIN GENERATED CODEX HOOK TRUST STATE";
export const CODEX_HOOK_TRUST_END = "# END GENERATED CODEX HOOK TRUST STATE";

const EVENT_NAMES: Record<CodexHookEvent, string> = {
  PreToolUse: "pre_tool_use",
  PermissionRequest: "permission_request",
  PostToolUse: "post_tool_use",
  PostToolUseFailure: "post_tool_use_failure",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionStart: "session_start",
  UserPromptSubmit: "user_prompt_submit",
  Stop: "stop",
};

const MATCHER_EVENTS = new Set<CodexHookEvent>([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "PreCompact",
  "PostCompact",
  "SessionStart",
]);

export function buildCodexHookTrustBlock(input: {
  hooksConfig: unknown;
  codexHooksSourcePath: string;
}): string {
  const hooksConfig = input.hooksConfig as { hooks?: Record<string, unknown> };
  const lines = [
    CODEX_HOOK_TRUST_BEGIN,
    "# Codex only runs unmanaged hooks after their current definition has been",
    "# reviewed. These entries are generated from adapters/codex/dotcodex/hooks.json.",
    "# Regenerate them with `just build` after changing Codex hook commands.",
  ];
  for (const [eventName, eventGroups] of Object.entries(hooksConfig.hooks ?? {})) {
    if (!isCodexHookEvent(eventName)) {
      throw new Error(`Unknown Codex hook event: ${eventName}`);
    }
    const codexEventName = EVENT_NAMES[eventName];
    if (!Array.isArray(eventGroups)) continue;
    for (const [groupIndex, group] of eventGroups.entries()) {
      const hooks = (group as { hooks?: unknown[] }).hooks ?? [];
      for (const [hookIndex, hook] of hooks.entries()) {
        const key = `${input.codexHooksSourcePath}:${codexEventName}:${groupIndex}:${hookIndex}`;
        lines.push("");
        lines.push(`[hooks.state."${key}"]`);
        lines.push("enabled = true");
        lines.push(`trusted_hash = "${currentHash(hookIdentity(eventName, group, hook))}"`);
      }
    }
  }
  lines.push(CODEX_HOOK_TRUST_END);
  return lines.join("\n");
}

function isCodexHookEvent(value: string): value is CodexHookEvent {
  return (CODEX_HOOK_EVENTS as readonly string[]).includes(value);
}

function hookIdentity(eventName: CodexHookEvent, group: unknown, hook: unknown): Record<string, unknown> {
  const rawGroup = group as { matcher?: unknown };
  const rawHook = hook as {
    type?: unknown;
    command?: unknown;
    timeout?: unknown;
    async?: unknown;
    statusMessage?: unknown;
  };
  const identity: Record<string, unknown> = {
    event_name: EVENT_NAMES[eventName],
    hooks: [{
      type: rawHook.type,
      command: rawHook.command,
      timeout: Math.max(typeof rawHook.timeout === "number" ? rawHook.timeout : 600, 1),
      async: rawHook.async ?? false,
    }],
  };
  if (MATCHER_EVENTS.has(eventName) && rawGroup.matcher !== undefined) identity.matcher = rawGroup.matcher;
  if (rawHook.statusMessage !== undefined) {
    (identity.hooks as Record<string, unknown>[])[0].statusMessage = rawHook.statusMessage;
  }
  return identity;
}

function currentHash(value: unknown): string {
  return digestCanonicalJson(value);
}
