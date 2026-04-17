import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { isEditTool, isEditIntentExemptPath } from "../utils/edit-intent.js";
import { appealHelper } from "../agents/hooks/tool-appeal.js";
import { readTranscriptExact, formatTranscriptResult } from "../utils/transcript.js";
import { APPEAL_COUNTS } from "../utils/transcript-presets.js";

export const editIntentRule: PreToolRule = {
  name: "edit-intent",
  displayName: "Edit Intent",
  priority: 60,
  appealable: true,
  usesLlm: false,
  promptSection: "",

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const filePath =
      (ctx.toolInput as { file_path?: string }).file_path ||
      (ctx.toolInput as { path?: string }).path || "";

    if (!filePath || isEditIntentExemptPath(filePath)) {
      return null;
    }

    if (!isEditTool(ctx.toolName)) {
      return null;
    }

    if ((ctx.state.currentEditIntent ?? null) !== false) {
      return null;
    }

    const editIntentReason = `Edit intent is false - user has not requested file modifications. Target: ${filePath}`;

    // Appeal with MAJOR HINT (strong signal to uphold)
    const eiTranscript = formatTranscriptResult(
      await readTranscriptExact(ctx.transcriptPath, APPEAL_COUNTS)
    );

    const appeal = await appealHelper(
      ctx.toolName,
      `${ctx.toolName} to ${filePath}`,
      eiTranscript,
      editIntentReason,
      ctx.projectDir,
      "PreToolUse",
      `=== EDIT INTENT WARNING ===
The edit intent classifier has determined the user does NOT want file edits right now.
This is a STRONG signal. The user's message was analyzed and classified as non-edit intent.
You should STRONGLY LEAN toward UPHOLD unless you find EXPLICIT, UNAMBIGUOUS user approval
for editing files (e.g., "make the change", "fix it", "implement it", "go ahead and edit").
Questions, discussions, or exploration of code do NOT count as edit approval.
If in doubt, UPHOLD.
=== END EDIT INTENT WARNING ===`
    );

    if (!appeal.overturned) {
      return { fastDeny: editIntentReason };
    }

    // BREAKTHROUGH: Track overturned edit-intent appeals (persisted in SessionState)
    const overturnCount = (ctx.state.editIntentOverturnCount ?? 0) + 1;
    await ctx.stateManager.update((s) => ({
      ...s,
      editIntentOverturnCount: overturnCount,
      ...(overturnCount >= 2 ? { currentEditIntent: true as const, editIntentTimestamp: Date.now() } : {}),
    }));

    // Return null to continue pipeline (appeal overturned)
    return null;
  },
};
