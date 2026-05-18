import { describe, expect, it } from "vitest";

import { formatCheckFailure } from "../../../src/agents/mcp/confirm.js";

describe("formatCheckFailure", () => {
  it("preserves check errors when confirm declines before investigation", () => {
    const checkResult = `## Results
- Errors: 2
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:12: Type 'string' is not assignable to type 'number'.
src/bar.ts:8: 'unusedValue' is declared but its value is never read.

## Warnings
(none)`;

    const result = formatCheckFailure(checkResult, 2);

    expect(result).toContain("- Errors: 2");
    expect(result).toContain("## Check Errors");
    expect(result).toContain("src/foo.ts:12: Type 'string' is not assignable to type 'number'.");
    expect(result).toContain("src/bar.ts:8: 'unusedValue' is declared but its value is never read.");
    expect(result).toContain("DECLINED: check failed with 2 error(s); see Check Errors above.");
  });

  it("falls back to full check output when the errors section is missing", () => {
    const checkResult = "tool failed before producing structured sections";

    const result = formatCheckFailure(checkResult, 1);

    expect(result).toContain("tool failed before producing structured sections");
  });
});
