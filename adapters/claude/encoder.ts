/**
 * Claude adapter encoder — translates framework decisions into Claude's
 * expected stdout JSON shapes.
 *
 * This is the ONLY Claude-specific stdout code in the framework.
 * All other hook logic is adapter-agnostic.
 *
 * @module adapters/claude/encoder
 */

import type { AdapterEncoder, EncodedOutput, EventName } from "../../src/adapter/types.js";

export const claudeEncoder: AdapterEncoder = {
  name: "claude",

  encodePreToolUseAllow(): EncodedOutput {
    return {
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
        },
      }),
      exitCode: 0,
    };
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

  encodeStopBlock(reason: string): EncodedOutput {
    return {
      stdout: JSON.stringify({ decision: "block", reason }),
      exitCode: 0,
    };
  },

  encodeStopPass(): EncodedOutput {
    return { stdout: "", exitCode: 0 };
  },

  encodeOk(_event: EventName): EncodedOutput {
    return { stdout: "", exitCode: 0 };
  },

  encodeContext(_event: EventName, message: string): EncodedOutput {
    return { stdout: JSON.stringify({ systemMessage: message }), exitCode: 0 };
  },

  encodeError(_event: EventName, _message: string): EncodedOutput {
    return { stdout: "", exitCode: 1 };
  },
};
