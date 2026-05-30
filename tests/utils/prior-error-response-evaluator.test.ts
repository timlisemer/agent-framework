import { describe, expect, it } from "vitest";
import { evaluatePriorErrorResponse } from "../../src/utils/prior-error-response-evaluator.js";
import type { PriorErrorContext } from "../../src/utils/prior-error-context.js";

const planfilePriorError: PriorErrorContext = {
  source: "plan-validation",
  provenance: ["transcript"],
  tool: "plan-validate",
  text: "Plan validation failed: missing section. Iterate on the planfile using validate_plan for /tmp/session/plans/fix-plan.md until it passes; edit that planfile directly even if plan mode is active, because planfile edits are explicitly allowed. Present the validated file as <proposed_plan>...</proposed_plan>.",
  index: 10,
};

function prior(text: string, source: PriorErrorContext["source"] = "tool-failure"): PriorErrorContext {
  return {
    source,
    provenance: ["transcript"],
    tool: "Bash",
    text,
    index: 1,
  };
}

describe("evaluatePriorErrorResponse", () => {
  it("returns defer with no meaningful overlap", () => {
    expect(evaluatePriorErrorResponse("I updated the README and tests passed.", [
      prior("Command failed with exit code 1 while running npm test."),
    ])).toEqual({ status: "defer" });
  });

  it("detects generic prior-error violation with inability language", () => {
    const result = evaluatePriorErrorResponse("I can't fix the exit code failure because the tool is unavailable.", [
      prior("Command failed with exit code 1 while running npm test."),
    ]);
    expect(result.status).toBe("violated");
  });

  it("uses caller order instead of mixing transcript indexes and tool-log timestamps", () => {
    const result = evaluatePriorErrorResponse("I can't edit the planfile because Plan Mode forbids file writes.", [
      {
        source: "tool-failure",
        provenance: ["tool-log"],
        tool: "Bash",
        text: "Command failed with exit code 1 while running npm test.",
        ts: 9999999999999,
      },
      planfilePriorError,
    ]);
    expect(result).toMatchObject({
      status: "violated",
      stopBlock: expect.stringContaining("You refused the required planfile validation remediation"),
    });
  });

  it("detects generic prior-error violation with conflict language", () => {
    const result = evaluatePriorErrorResponse("The tool denial conflicts with the higher-priority instruction, so I cannot proceed.", [
      prior("Tool call denied: edit the requested file directly.", "tool-denial"),
    ]);
    expect(result.status).toBe("violated");
  });

  it("detects generic prior-error violation with blocked language", () => {
    const result = evaluatePriorErrorResponse("I am blocked on the failed validate_plan result until you decide what to do.", [
      prior("Plan validation failed: run validate_plan again after editing the planfile.", "plan-validation"),
    ]);
    expect(result.status).toBe("violated");
  });

  it("detects generic prior-error violation with workaround language", () => {
    const result = evaluatePriorErrorResponse("Instead of handling the denied tool call, I can offer two options.", [
      prior("Tool call denied: do not offer options; resume the requested edit.", "tool-denial"),
    ]);
    expect(result.status).toBe("violated");
  });

  it("detects explicit planfile remediation refusal", () => {
    const result = evaluatePriorErrorResponse(
      "I can't edit the planfile because Plan Mode forbids file writes, so higher-priority write restrictions take precedence.",
      [planfilePriorError],
    );
    expect(result).toMatchObject({
      status: "violated",
      stopBlock: expect.stringContaining("You refused the required planfile validation remediation"),
    });
  });

  it("detects governing instruction planfile remediation refusal", () => {
    const result = evaluatePriorErrorResponse(
      "I can't perform that remediation in this active Plan Mode turn because it requires editing a file, and the governing instruction for this turn forbids file writes.",
      [planfilePriorError],
    );
    expect(result).toMatchObject({
      status: "violated",
      stopBlock: expect.stringContaining("You refused the required planfile validation remediation"),
    });
  });

  it("detects higher-level instruction prevents planfile remediation", () => {
    const result = evaluatePriorErrorResponse(
      "The hook wants the planfile edited and validated, but higher-level instructions prevent this file write.",
      [planfilePriorError],
    );
    expect(result).toMatchObject({
      status: "violated",
      stopBlock: expect.stringContaining("Edit the named planfile directly"),
    });
  });

  it("allows explicit planfile remediation commitment as satisfied without full pass", () => {
    const result = evaluatePriorErrorResponse(
      "I will edit the planfile directly and then run validate_plan for that same path until it passes.",
      [planfilePriorError],
    );
    expect(result).toEqual({
      status: "satisfied",
      reason: "planfile remediation commitment",
    });
  });

  it("does not block rejecting an inline-only plan while committing to remediation", () => {
    const result = evaluatePriorErrorResponse(
      "I will not emit another inline-only plan. I will edit the planfile directly and then run validate_plan for that same path until it passes.",
      [planfilePriorError],
    );
    expect(result).toEqual({
      status: "satisfied",
      reason: "planfile remediation commitment",
    });
  });

  it("does not block rejecting Plan Mode argument while committing to remediation", () => {
    const result = evaluatePriorErrorResponse(
      "Instead of arguing about Plan Mode writes, I will edit the planfile directly and then run validate_plan for that same path until it passes.",
      [planfilePriorError],
    );
    expect(result).toEqual({
      status: "satisfied",
      reason: "planfile remediation commitment",
    });
  });

  it("strips quoted prior-error examples before scoring", () => {
    const result = evaluatePriorErrorResponse([
      "The transcript contains this earlier refusal:",
      "> I can't edit the planfile because Plan Mode forbids file writes.",
      "That quoted example is the failure I will avoid.",
    ].join("\n"), [planfilePriorError]);
    expect(result).toEqual({ status: "defer" });
  });

  it("does not block missing path clarification", () => {
    const result = evaluatePriorErrorResponse(
      "I need the exact planfile path before I can edit it.",
      [planfilePriorError],
    );
    expect(result).toEqual({ status: "defer" });
  });

  it("does not use planfile profile for non-planfile prior errors", () => {
    const result = evaluatePriorErrorResponse("I can't inspect the exit code because the Bash tool is unavailable.", [
      prior("Command failed with exit code 2."),
    ]);
    expect(result).toMatchObject({ status: "violated" });
    if (result.status === "violated") {
      expect(result.stopBlock).not.toContain("planfile validation remediation");
    }
  });

  it("returns defer for generic completion evidence", () => {
    const result = evaluatePriorErrorResponse("I fixed the failed test and reran npm test; it passed.", [
      prior("Command failed with exit code 1 while running npm test."),
    ]);
    expect(result).toEqual({ status: "defer" });
  });

  it("does not deterministically block normal completion summary after failed test output", () => {
    const result = evaluatePriorErrorResponse("I fixed the assertion and the tests now pass.", [
      prior("FAILED tests/utils/example.test.ts > expected true to be false\nexit code 1"),
    ]);
    expect(result).toEqual({ status: "defer" });
  });
});
