import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";

export const editIntentContextRule: PreToolRule = {
  name: "edit-intent-context",
  displayName: "Edit Intent Context",
  priority: 74,
  appealable: false,
  usesLlm: true,
  promptSection: `If edit intent is false and an edit tool arrives, it was already blocked by TypeScript. The current tool is therefore NOT an edit tool — but the user's exploration/read-only intent still informs whether tangential write-ish operations (Bash with side effects, Agent dispatch) are warranted.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    const editIntent = ctx.state.currentEditIntent ?? null;
    if (editIntent !== false) return null;
    return { llmContext: "EDIT INTENT: false (user requested read-only / non-edit work)" };
  },
};
