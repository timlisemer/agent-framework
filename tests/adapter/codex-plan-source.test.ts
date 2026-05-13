import { describe, expect, it } from "vitest";
import {
  CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX,
  CODEX_IMPLEMENT_PLAN_PROMPT,
  extractProposedPlanContent,
  findCurrentPlanSource,
  isPlanExit,
  parseCodexProposedPlanBlock,
} from "../../adapters/codex/plan-source.js";

describe("Codex plan source", () => {
  it("extracts whole-message proposed_plan blocks", () => {
    const text = "  <proposed_plan>\n## User Goal\nDo it.\n</proposed_plan>\n";
    expect(parseCodexProposedPlanBlock(text)).toEqual({
      content: "## User Goal\nDo it.",
    });
    expect(extractProposedPlanContent(text)).toBe("## User Goal\nDo it.");
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(true);
  });

  it("ignores proposed_plan blocks embedded in surrounding prose", () => {
    const text = "before\n<proposed_plan>\n## User Goal\nDo it.\n</proposed_plan>\nafter";
    expect(parseCodexProposedPlanBlock(text)).toBeNull();
    expect(extractProposedPlanContent(text)).toBeNull();
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(false);
  });

  it("ignores quoted or backticked proposed_plan examples", () => {
    const text = "Use `<proposed_plan>...</proposed_plan>` for final plans.";
    expect(extractProposedPlanContent(text)).toBeNull();
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(false);
  });

  it("ignores empty proposed_plan blocks", () => {
    const text = "<proposed_plan>\n\n</proposed_plan>";
    expect(extractProposedPlanContent(text)).toBeNull();
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(false);
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
