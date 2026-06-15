import type { EncodedOutput } from "../../src/adapter/types.js";

/**
 * Shared by adapters that intentionally use the same PreToolUse deny wire
 * shape. Keep host-specific stdout JSON helpers under adapters/.
 */
export function encodePreToolUseDenyOutput(reason: string): EncodedOutput {
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
}

export function encodeDecisionBlockOutput(reason: string): EncodedOutput {
  return {
    stdout: JSON.stringify({ decision: "block", reason }),
    exitCode: 0,
  };
}
