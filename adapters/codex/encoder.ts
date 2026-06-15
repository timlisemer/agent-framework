import type { AdapterEncoder, EncodedOutput, EventName } from "../../src/adapter/types.js";
import { encodeDecisionBlockOutput, encodePreToolUseDenyOutput } from "../shared/encoder-output.js";

function encodeCodexAdditionalContextBlock(
  hookEventName: "PostToolUse" | "UserPromptSubmit",
  reason: string,
): EncodedOutput {
  return {
    stdout: JSON.stringify({
      decision: "block",
      reason,
      hookSpecificOutput: {
        hookEventName,
        additionalContext: reason,
      },
    }),
    exitCode: 0,
  };
}

export const codexEncoder: AdapterEncoder = {
  name: "codex",

  encodePreToolUseAllow(): EncodedOutput {
    return { stdout: "", exitCode: 0 };
  },

  encodePreToolUseDeny(reason: string): EncodedOutput {
    return encodePreToolUseDenyOutput(reason);
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
    return encodeCodexAdditionalContextBlock("PostToolUse", reason);
  },

  encodeStopBlock(reason: string): EncodedOutput {
    return encodeDecisionBlockOutput(reason);
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
    return encodeCodexAdditionalContextBlock("UserPromptSubmit", reason);
  },
};
