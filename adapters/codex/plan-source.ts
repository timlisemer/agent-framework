import type {
  NativePlanFileLookupInput,
  PlanExitDetectionInput,
} from "../../src/adapter/types.js";
import { extractMarkdownPlanPresentation } from "../../src/utils/plan-contract.js";

export const CODEX_IMPLEMENT_PLAN_PROMPT = "Implement the plan.";

export const CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX =
  "A previous agent produced the plan below to accomplish the user's task.\n" +
  "Implement the plan in a fresh context. Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation and verification.";

export interface CodexProposedPlanBlock {
  content: string;
}

const WHOLE_PROPOSED_PLAN_RE =
  /^\s*<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>\s*$/;

export function parseCodexProposedPlanBlock(
  text: string | null | undefined,
): CodexProposedPlanBlock | null {
  if (!text) return null;
  const match = text.match(WHOLE_PROPOSED_PLAN_RE);
  const content = match?.[1]?.trim();
  return content ? { content } : null;
}

export function extractProposedPlanContent(text: string | null | undefined): string | null {
  return parseCodexProposedPlanBlock(text)?.content ?? null;
}

export function extractStopProposedPlan(text: string | null | undefined): string | null {
  return extractProposedPlanContent(text) ?? extractMarkdownPlanPresentation(text);
}

function isImplementationPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  return trimmed === CODEX_IMPLEMENT_PLAN_PROMPT ||
    trimmed.startsWith(CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX);
}

export function findNativePlanFile(_input: NativePlanFileLookupInput): string | null {
  return null;
}

export function isPlanExit(input: PlanExitDetectionInput): boolean {
  if (input.event === "Stop") {
    return extractStopProposedPlan(input.assistantText) !== null;
  }
  if (input.event === "UserPromptSubmit") {
    return isImplementationPrompt(input.prompt);
  }
  return false;
}
