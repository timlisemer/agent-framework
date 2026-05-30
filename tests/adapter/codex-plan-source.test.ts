import { describe, expect, it } from "vitest";
import {
  CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX,
  CODEX_IMPLEMENT_PLAN_PROMPT,
  extractProposedPlanContent,
  extractStopProposedPlan,
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
    expect(extractStopProposedPlan(text)).toBe("## User Goal\nDo it.");
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

  it("extracts only the outer proposed_plan tags", () => {
    const text = [
      "<proposed_plan>",
      "## User Goal",
      "Document the plan.",
      "</proposed_plan>",
    ].join("\n");

    const expected = "## User Goal\nDocument the plan.";
    expect(parseCodexProposedPlanBlock(text)).toEqual({ content: expected });
    expect(extractProposedPlanContent(text)).toBe(expected);
    expect(extractStopProposedPlan(text)).toBe(expected);
  });

  it("ignores incomplete proposed_plan blocks", () => {
    expect(extractProposedPlanContent("<proposed_plan>\nmissing close")).toBeNull();
    expect(isPlanExit({ event: "Stop", assistantText: "<proposed_plan>\nmissing close" })).toBe(false);
  });

  it("detects implementation prompts", () => {
    expect(isPlanExit({ event: "UserPromptSubmit", prompt: CODEX_IMPLEMENT_PLAN_PROMPT })).toBe(true);
    const prompt = `${CODEX_CLEAR_CONTEXT_IMPLEMENT_PLAN_PREFIX}\n\n## User Goal\nImplement it.`;
    expect(isPlanExit({ event: "UserPromptSubmit", prompt })).toBe(true);
  });

  it("extracts whole-message markdown plan approval text", () => {
    const text = [
      "# Remove Standalone Config Route",
      "",
      "## Summary",
      "",
      "Remove the old page.",
      "",
      "## Key Changes",
      "",
      "- Delete the route file.",
      "",
      "Implement this plan?",
    ].join("\n");

    expect(extractStopProposedPlan(text)).toContain("## Summary");
    expect(extractStopProposedPlan(text)).not.toContain("Implement this plan?");
    expect(isPlanExit({ event: "Stop", assistantText: text })).toBe(true);
  });
});
