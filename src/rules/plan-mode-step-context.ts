import type { PreToolRule, RuleContext, RuleCheckResult } from "./types.js";
import { readToolLogEntries } from "../utils/session-store.js";
import { detectIntentFulfillment } from "../utils/intent-fulfillment.js";

const PLAN_MODE_STEP_CONTEXT_STRING = `=== PLAN MODE STEP AWARENESS ===
Plan mode proceeds in steps:
  1. The user starts by requesting exploration/planning work (Task/Agent dispatches like plan or validator agents, Read, Grep, Glob, AskUserQuestion).
  2. Once the AI has completed the planning work the user requested, the natural next-step toolset shifts:
     - ExitPlanMode is the prescribed terminal step when the AI judges the plan complete.
     - Read-only tools (Read, Grep, Glob, LS, read-only Bash) remain appropriate for continued planning on the AI's own initiative.
     - AskUserQuestion remains appropriate for clarifying questions.
     - Additional Task/Agent dispatches remain appropriate but are no longer THE primary user interest unless re-requested.
     - Write/Edit/NotebookEdit to non-plan files remains inappropriate (already blocked deterministically upstream by plan-mode-block — you should never need to deny those here).
  3. ExitPlanMode is NOT a contradiction of an earlier user request to "run validators" or "explore X" once that exploration has been completed — it is the workflow's terminal step.

When INTENT FULFILLMENT is also present, the cached intent's request has already been served. APPROVE the firing tool when it fits the new step (especially ExitPlanMode); DENY only when the firing tool clearly does something the user explicitly forbade.
=== END PLAN MODE STEP AWARENESS ===`;

export const planModeStepContextRule: PreToolRule = {
  name: "plan-mode-step-context",
  displayName: "Plan Mode Step Context",
  priority: 77,
  appealable: false,
  usesLlm: true,
  promptSection: `If "PLAN MODE STEP AWARENESS" appears in context, plan mode is active and you must reason about which step the workflow is in. The block lists the appropriate next-step toolset. ExitPlanMode is the prescribed terminal step — APPROVE it when planning is done.`,

  async check(ctx: RuleContext): Promise<RuleCheckResult> {
    if (!ctx.planModeCtx.active) return null;
    const prediction = ctx.state.currentPrediction;
    if (!prediction) return null;
    const tail = readToolLogEntries(ctx.sessionDir, 50);
    const signal = detectIntentFulfillment(prediction, tail);
    if (!signal) return null;
    return { llmContext: PLAN_MODE_STEP_CONTEXT_STRING };
  },
};
