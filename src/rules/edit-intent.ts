import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import { extractFilePaths } from "./utils.js";
import { EDIT_INTENT_RULE_POLICY } from "./policies.js";
import { RULE_GATE_AGENT } from "../utils/agent-configs.js";

const EDIT_INTENT_APPEAL_GUIDANCE = `=== EDIT INTENT WARNING ===
The edit intent classifier has determined the user does NOT want file edits right now.
This is a STRONG signal. The user's message was analyzed and classified as non-edit intent.
You should STRONGLY LEAN toward UPHOLD unless you find EXPLICIT, UNAMBIGUOUS user approval
for editing files (e.g., "make the change", "fix it", "implement it", "go ahead and edit").
Questions, discussions, or exploration of code do NOT count as edit approval.
If in doubt, UPHOLD.
=== END EDIT INTENT WARNING ===`;

export const editIntentRule: PreToolRule = {
  name: "edit-intent",
  displayName: "Edit Intent",
  priority: 60,
  appealable: true,
  usesLlm: true,
  evaluationAgent: RULE_GATE_AGENT,
  version: "1",
  configuration: EDIT_INTENT_RULE_POLICY,
  promptSection: "",
  appealGuidance: EDIT_INTENT_APPEAL_GUIDANCE,

  async onAppealOverturned(ctx: RuleContext): Promise<void> {
    await ctx.stateManager.update((state) => {
      const overturnCount = (state.editIntentOverturnCount ?? 0) + 1;
      return {
        ...state,
        editIntentOverturnCount: overturnCount,
        ...(overturnCount >= EDIT_INTENT_RULE_POLICY.appealOverturnThreshold
          ? {
              currentEditIntent: true as const,
              editIntentTimestamp: Date.now(),
            }
          : {}),
      };
    });
  },

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!isEditTool(ctx.toolName)) {
      return null;
    }

    const filePaths = extractFilePaths(ctx.toolName, ctx.toolInput);
    if (filePaths.length === 0) {
      return {
        fastDeny: `${ctx.toolName} must identify at least one target file.`,
      };
    }

    const blockedPaths = filePaths.filter(
      (filePath) => !isEditIntentExemptPath(filePath, ctx.sessionDir),
    );
    if (blockedPaths.length === 0) {
      return null;
    }

    if ((ctx.state.currentEditIntent ?? null) !== false) {
      return null;
    }

    const target = blockedPaths.join(", ");
    const editIntentReason = `Edit intent is false - user has not requested file modifications. Target: ${target}`;
    return { fastDeny: editIntentReason };
  },
};
