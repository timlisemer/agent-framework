import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { activeSpec } from "../adapter/spec.js";

/**
 * Force-Check-Required Rule (priority 32)
 *
 * Set by tool-approve.onDenialConfirmed when a workaround Bash command is
 * denied. While `state.forceCheckPending` is true, all tools are denied except
 * the framework check MCP and `ToolSearch`. Cleared in pre-tool-use.ts
 * after the check tool is allowed.
 *
 * Not appealable: this is a deliberate lockout, not a heuristic guess.
 */
export const forceCheckRequiredRule: PreToolRule = {
  name: "force-check-required",
  displayName: "Force Check Required",
  priority: 32,
  appealable: false,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (ctx.subagent) return null;
    if (!ctx.state.forceCheckPending) return null;
    const spec = activeSpec();
    const rawName = ctx.rawToolName ?? ctx.toolName;
    if (spec.recognizeMcp(rawName) === "check" || ctx.toolName === "ToolSearch") return null;
    return {
      fastDeny:
        `Workaround Bash command was denied earlier. You must run ${spec.renderCheckMcpHint()} before any other tool.`,
    };
  },
};
