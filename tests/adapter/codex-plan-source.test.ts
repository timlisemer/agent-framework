import { describe, expect, it } from "vitest";
import {
  CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX,
  CODEX_IMPLEMENT_PLAN_PROMPT,
  extractProposedPlanContent,
  findCurrentPlanSource,
  isPlanExit,
} from "../../adapters/codex/plan-source.js";

describe("Codex plan source", () => {
  it("extracts complete proposed_plan blocks", () => {
    const text = "before\n<proposed_plan>\n## User Goal\nDo it.\n</proposed_plan>\nafter";
    expect(extractProposedPlanContent(text)).toBe("## User Goal\nDo it.");
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(true);
  });

  it("ignores incomplete proposed_plan blocks", () => {
    expect(extractProposedPlanContent("<proposed_plan>\nmissing close")).toBeNull();
    expect(isPlanExit({ event: "Stop", assistantText: "<proposed_plan>\nmissing close" })).toBe(false);
  });

  it("detects implementation prompts and embedded clear-context plans", () => {
    expect(isPlanExit({ event: "UserPromptSubmit", prompt: CODEX_IMPLEMENT_PLAN_PROMPT })).toBe(true);
    const prompt = `${CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX}\n\n## User Goal\nImplement it.`;
    expect(isPlanExit({ event: "UserPromptSubmit", prompt })).toBe(true);
    expect(findCurrentPlanSource({ transcriptPath: "x", prompt })).toEqual({
      kind: "inline",
      content: "## User Goal\nImplement it.",
      source: "codex-clear-context-implementation-prompt",
    });
  });
});
