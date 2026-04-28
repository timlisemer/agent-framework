import { describe, it, expect } from "vitest";
import {
  evaluateReasonMust,
  formatReasonMustFailure,
  scoreRichExpectation,
} from "../../test-harness/lib/hook-runner.js";
import type {
  ReasonMustExpectation,
} from "../../src/agents/mcp/scenario-types.js";

describe("evaluateReasonMust", () => {
  it("returns empty array for empty reason_must", () => {
    const out = evaluateReasonMust("anything", {} as ReasonMustExpectation);
    expect(out).toEqual([]);
  });

  it("contains: present substring → pass", () => {
    const out = evaluateReasonMust("hello world", { contains: ["world"] });
    expect(out).toEqual([{ kind: "contains", pattern: "world", pass: true }]);
  });

  it("contains: absent substring → fail with first-missing entry", () => {
    const out = evaluateReasonMust("hello world", {
      contains: ["world", "nope"],
    });
    expect(out).toEqual([
      { kind: "contains", pattern: "world", pass: true },
      { kind: "contains", pattern: "nope", pass: false },
    ]);
  });

  it("not_contains: absent → pass", () => {
    const out = evaluateReasonMust("hello", {
      not_contains: ["world"],
    });
    expect(out).toEqual([{ kind: "not_contains", pattern: "world", pass: true }]);
  });

  it("not_contains: present → fail", () => {
    const out = evaluateReasonMust("hello world", {
      not_contains: ["world"],
    });
    expect(out).toEqual([
      { kind: "not_contains", pattern: "world", pass: false },
    ]);
  });

  it("matches: regex hit → pass", () => {
    const out = evaluateReasonMust("hello 123 world", {
      matches: ["\\d+"],
    });
    expect(out).toEqual([{ kind: "matches", pattern: "\\d+", pass: true }]);
  });

  it("matches: regex miss → fail", () => {
    const out = evaluateReasonMust("hello world", {
      matches: ["\\d+"],
    });
    expect(out).toEqual([{ kind: "matches", pattern: "\\d+", pass: false }]);
  });

  it("not_matches: miss → pass", () => {
    const out = evaluateReasonMust("hello world", {
      not_matches: ["\\d+"],
    });
    expect(out).toEqual([{ kind: "not_matches", pattern: "\\d+", pass: true }]);
  });

  it("not_matches: hit → fail", () => {
    const out = evaluateReasonMust("hello 123", {
      not_matches: ["\\d+"],
    });
    expect(out).toEqual([{ kind: "not_matches", pattern: "\\d+", pass: false }]);
  });

  it("undefined reason treated as empty string → contains fails", () => {
    const out = evaluateReasonMust(undefined, { contains: ["x"] });
    expect(out).toEqual([{ kind: "contains", pattern: "x", pass: false }]);
  });

  it("undefined reason → not_contains passes (empty string contains nothing)", () => {
    const out = evaluateReasonMust(undefined, { not_contains: ["x"] });
    expect(out).toEqual([{ kind: "not_contains", pattern: "x", pass: true }]);
  });

  it("multiple clauses combined: all pass → all pass", () => {
    const out = evaluateReasonMust("hello world 123", {
      contains: ["world"],
      not_contains: ["foo"],
      matches: ["\\d+"],
      not_matches: ["xyz"],
    });
    expect(out.every((r) => r.pass)).toBe(true);
    expect(out.length).toBe(4);
  });

  it("multiple clauses combined: short-circuits at first violator", () => {
    const out = evaluateReasonMust("hello world", {
      contains: ["world"],
      not_contains: ["world"], // fails
      matches: ["\\d+"], // not reached
    });
    expect(out).toEqual([
      { kind: "contains", pattern: "world", pass: true },
      { kind: "not_contains", pattern: "world", pass: false },
    ]);
  });
});

describe("formatReasonMustFailure", () => {
  it("contains failure", () => {
    expect(
      formatReasonMustFailure({ kind: "contains", pattern: "x", pass: false }),
    ).toBe('reason missing required substring "x"');
  });

  it("not_contains failure", () => {
    expect(
      formatReasonMustFailure({
        kind: "not_contains",
        pattern: "x",
        pass: false,
      }),
    ).toBe('reason contains forbidden substring "x"');
  });

  it("matches failure", () => {
    expect(
      formatReasonMustFailure({ kind: "matches", pattern: "x", pass: false }),
    ).toBe("reason did not match required regex /x/");
  });

  it("not_matches failure", () => {
    expect(
      formatReasonMustFailure({
        kind: "not_matches",
        pattern: "x",
        pass: false,
      }),
    ).toBe("reason matched forbidden regex /x/");
  });
});

describe("scoreRichExpectation reason_must integration", () => {
  it("returns { pass: false, reason, reason_must_results } shape on violation", () => {
    const out = scoreRichExpectation(
      "deny",
      "tool-approve",
      {
        expected: "deny",
        by: "tool-approve",
        reason_must: { not_contains: ["bad"] },
      },
      { actualReason: "this contains bad text" },
    );
    expect(out.pass).toBe(false);
    expect(out.reason).toBe('reason contains forbidden substring "bad"');
    expect(out.reason_must_results).toEqual([
      { kind: "not_contains", pattern: "bad", pass: false },
    ]);
  });

  it("returns { pass: true } when reason_must absent", () => {
    const out = scoreRichExpectation(
      "deny",
      "tool-approve",
      { expected: "deny", by: "tool-approve" },
      { actualReason: "anything" },
    );
    expect(out.pass).toBe(true);
    expect(out.reason).toBeUndefined();
    expect(out.reason_must_results).toBeUndefined();
  });

  it("ScoreContext with only actualReason (no sessionDir/toolName/toolInput) accepted", () => {
    const out = scoreRichExpectation(
      "block",
      undefined,
      {
        expected: "block",
        reason_must: { contains: ["stop response"] },
      },
      { actualReason: "stop response: blocked" },
    );
    expect(out.pass).toBe(true);
  });

  it("reason_must passes when all clauses pass", () => {
    const out = scoreRichExpectation(
      "deny",
      "tool-approve",
      {
        expected: "deny",
        by: "tool-approve",
        reason_must: {
          contains: ["node not covered"],
          not_contains: ["Use Read tool with offset"],
        },
      },
      { actualReason: "node not covered by just check" },
    );
    expect(out.pass).toBe(true);
  });

  it("reason_must violation overrides decision-pass when within decision+gate-OK branch", () => {
    const out = scoreRichExpectation(
      "deny",
      "tool-approve",
      {
        expected: "deny",
        by: "tool-approve",
        reason_must: { contains: ["something missing"] },
      },
      { actualReason: "node not covered" },
    );
    expect(out.pass).toBe(false);
  });
});
