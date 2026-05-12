import type {
  PlanExitDetectionInput,
  PlanSourceDescriptor,
  PlanSourceLookupInput,
} from "../../src/adapter/types.js";

export const CODEX_IMPLEMENT_PLAN_PROMPT = "Implement the plan.";

export const CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX =
  "A previous agent produced the plan below to accomplish the user's task.\n" +
  "Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";

export function extractProposedPlanContent(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g)];
  const last = matches[matches.length - 1];
  const content = last?.[1]?.trim();
  return content ? content : null;
}

function isImplementationPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === CODEX_IMPLEMENT_PLAN_PROMPT ||
    trimmed.startsWith(CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX);
}

export function findCurrentPlanSource(input: PlanSourceLookupInput): PlanSourceDescriptor | null {
  const assistantPlan = extractProposedPlanContent(input.assistantText);
  if (assistantPlan) {
    return { kind: "inline", content: assistantPlan, source: "codex-proposed-plan" };
  }

  const promptPlan = extractProposedPlanContent(input.prompt);
  if (promptPlan) {
    return { kind: "inline", content: promptPlan, source: "codex-implementation-prompt" };
  }

  if (input.prompt?.trim().startsWith(CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX)) {
    const content = input.prompt.trim().slice(CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX.length).trim();
    if (content) {
      return { kind: "inline", content, source: "codex-clear-context-implementation-prompt" };
    }
  }

  return null;
}

export function isPlanExit(input: PlanExitDetectionInput): boolean {
  if (input.event === "Stop") {
    return extractProposedPlanContent(input.assistantText) !== null;
  }
  if (input.event === "UserPromptSubmit") {
    return isImplementationPrompt(input.prompt);
  }
  return false;
}
