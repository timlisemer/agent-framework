import type { AdapterEncoder, EncodedOutput, EventName } from "../../src/adapter/types.js";

export const codexEncoder: AdapterEncoder = {
  name: "codex",

  encodePreToolUseAllow(): EncodedOutput {
    return { stdout: "", exitCode: 0 };
  },

  encodePreToolUseDeny(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
      exitCode: 0,
    };
  },

  encodePermissionRequestAllow(): EncodedOutput {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "allow" },
        },
      }),
      exitCode: 0,
    };
  },

  encodePermissionRequestDeny(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: "deny", message: reason },
        },
      }),
      exitCode: 0,
    };
  },

  encodePostToolUseBlock(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "PostToolUse",
          additionalContext: reason,
        },
      }),
      exitCode: 0,
    };
  },

  encodeStopBlock(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({ decision: "block", reason }),
      exitCode: 0,
    };
  },

  encodeStopPass(): EncodedOutput {
    return { stdout: JSON.stringify({ continue: true }), exitCode: 0 };
  },

  encodeOk(_event: EventName): EncodedOutput {
    return { stdout: "", exitCode: 0 };
  },

  encodeContext(_event: EventName, message: string): EncodedOutput {
    return {
      stdout: JSON.stringify({
        systemMessage: message,
        // Codex common output fields document suppressOutput:
        // https://developers.openai.com/codex/hooks#common-output-fields
        suppressOutput: true,
      }),
      exitCode: 0,
    };
  },

  encodeError(event: EventName, message: string): EncodedOutput {
    if (event === "Stop") {
      return { stdout: JSON.stringify({ continue: true, systemMessage: message }), exitCode: 0 };
    }
    return { stdout: JSON.stringify({ systemMessage: message }), exitCode: 0 };
  },

  encodeUserPromptSubmitBlock(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({
        decision: "block",
        reason,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: reason,
        },
      }),
      exitCode: 0,
    };
  },
};
