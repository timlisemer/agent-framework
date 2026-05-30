import { describe, expect, it } from "vitest";
import {
  detectPlanfileEditRefusal,
  isPlanfileDirectEditCommitment,
} from "../../src/utils/stall-detect.js";

const remediationContext =
  "Plan validation failed: missing section. Iterate on the planfile using mcp__agent_framework__validate_plan for /tmp/session/plans/fix-plan.md until it passes; edit that planfile directly even if plan mode is active, because the named planfile is the planning surface, this is the required remediation path, not an implementation edit, and planfile edits are explicitly allowed.";

describe("detectPlanfileEditRefusal", () => {
  it.each([
    "I cannot perform step 1 because active Plan Mode forbids file writes, including edits to the planfile.",
    "I can’t edit the planfile in this turn because Plan Mode here explicitly forbids file writes.",
    "I can’t edit the planfile while the active Plan Mode instructions forbid file writes.",
    "I can’t edit the planfile in this turn because the active developer Plan Mode instruction forbids file writes.",
    "I can’t edit the planfile while this conversation is in Plan Mode. The active Plan Mode instruction forbids mutating actions, including editing or writing files.",
    "I can’t edit the planfile under this turn’s Plan Mode write restriction.",
    "I can’t edit the planfile from this turn because the active Plan Mode instruction for this session forbids file writes.",
    "I can’t edit the planfile in this Plan Mode turn.",
    "I can’t edit the planfile while this session is under Plan Mode’s no-file-writes rule.",
    "I cannot perform that edit while this Plan Mode instruction set forbids mutating actions, even though the hook message says planfile edits are allowed.",
    "Under the active Plan Mode developer instructions, I cannot write files. So the remaining hook failure is not a planning gap.",
    "I can still provide the exact replacement content or a patch for the planfile, but I can’t apply it from this active Plan Mode turn.",
    "That is a higher-priority instruction than your request and the Stop hook remediation.",
    "I understand the remediation says to edit the planfile, but higher-priority/Plan Mode restrictions still win.",
    "I have a higher-priority Plan Mode rule in this environment that says I must not mutate files. That conflicts with the hook remediation.",
    "I cannot both obey the hook and obey Plan Mode.",
    "This thread has to leave Plan Mode; then I can edit the planfile, run validate_plan, and present the validated contents.",
    "I’m blocked specifically on step 1 by the current Plan Mode rules.",
    "Continuing to emit inline plans will not satisfy the hook while that stale file remains unchanged.",
  ])("detects live planfile refusal sentence: %s", (assistantText) => {
    expect(detectPlanfileEditRefusal(assistantText, remediationContext))
      .toBe("planfile edit refusal during validation remediation");
  });

  it("detects refusal to edit the planfile because Plan Mode forbids writes", () => {
    expect(
      detectPlanfileEditRefusal(
        "I cannot perform step 1 because active Plan Mode forbids file writes, including edits to the planfile.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects exit-Plan-Mode workarounds instead of direct planfile editing", () => {
    expect(
      detectPlanfileEditRefusal(
        "We need to exit Plan Mode so I can edit the planfile, then I can run validation.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects arguing that higher-priority write restrictions override planfile remediation", () => {
    expect(
      detectPlanfileEditRefusal(
        "I understand the planfile says edits are explicitly allowed, but higher-priority write restrictions take precedence, so I cannot modify the planfile while Plan Mode is active.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects higher-priority slash Plan Mode restrictions still win arguing", () => {
    expect(
      detectPlanfileEditRefusal(
        "I understand the remediation says to edit the planfile, but higher-priority/Plan Mode restrictions still win.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects asking the user to resolve the Plan Mode conflict instead of editing", () => {
    expect(
      detectPlanfileEditRefusal(
        "There is a conflict between the planfile remediation instruction and Plan Mode. You need to resolve the conflict before I can edit it.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects staying blocked on planfile edits", () => {
    expect(
      detectPlanfileEditRefusal(
        "I stay blocked on the planfile edit because file write restrictions still apply in Plan Mode.",
        remediationContext,
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("detects direct planfile edit request refusal without validate_plan wording", () => {
    expect(
      detectPlanfileEditRefusal(
        "I can’t edit the planfile in this turn because Plan Mode here explicitly forbids file writes.",
        "can you please edit the planfile now",
      ),
    ).toBe("planfile edit refusal during validation remediation");
  });

  it("allows direct planfile editing and validate_plan commitments", () => {
    const assistantText =
      "I will edit the planfile directly and then run validate_plan for that same path until it passes.";
    expect(detectPlanfileEditRefusal(assistantText, remediationContext)).toBeNull();
    expect(isPlanfileDirectEditCommitment(assistantText, remediationContext)).toBe(true);
  });

  it("does not trigger on quoted refusal examples", () => {
    expect(
      detectPlanfileEditRefusal(
        [
          "The transcript contains this earlier refusal:",
          "> I cannot perform step 1 because active Plan Mode forbids file writes.",
          "That quoted example is the failure we are fixing.",
        ].join("\n"),
        remediationContext,
      ),
    ).toBeNull();
  });

  it("does not trigger outside planfile remediation context", () => {
    expect(
      detectPlanfileEditRefusal(
        "I cannot edit the planfile in Plan Mode.",
        "The user asked a general question about Plan Mode.",
      ),
    ).toBeNull();
  });

  it.each([
    "I can’t edit the planfile because the file does not exist at that path.",
    "I can’t edit the planfile because I need the exact planfile path first.",
    "Plan Mode is active, but I will edit the planfile directly and then run validate_plan.",
    "The quoted transcript says: I can’t edit the planfile in this turn because Plan Mode here explicitly forbids file writes.",
  ])("does not detect non-refusal or non-remediation text: %s", (assistantText) => {
    expect(detectPlanfileEditRefusal(assistantText, remediationContext)).toBeNull();
  });
});
