import { describe, it, expect } from "vitest";
import {
  applyStatusOverride,
  promoteUnusedCodeToErrors,
} from "../../../src/agents/mcp/check.js";

describe("applyStatusOverride", () => {
  it("forces FAIL when Errors > 0 even if existing Status says PASS", () => {
    const input = `## Results
- Errors: 2
- Warnings: 0
- Status: PASS

## Errors
some error

## Warnings
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: FAIL");
    expect(r).not.toContain("- Status: PASS");
  });

  it("forces PASS when Errors == 0", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1
- Status: FAIL

## Warnings
unused something
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: PASS");
  });

  it("defensive floor bumps Errors to 1 when ## Errors body has content but count says 0", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
real error message here
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toContain("- Status: FAIL");
  });

  it("injects a Status line if missing", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0

## Errors
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: PASS");
  });
});

describe("promoteUnusedCodeToErrors", () => {
  it("moves ESLint unused-var line from Warnings to Errors", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
src/foo.ts:5 'unused' is declared but its value is never read
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toContain("- Warnings: 0");
    expect(r).toMatch(/## Errors[\s\S]*declared but/);
  });

  it("moves Cargo 'unused variable' from Warnings to Errors", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: unused variable: \`x\`
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toMatch(/## Errors[\s\S]*unused variable/);
  });

  it("moves 'dead code' lint", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: dead code detected in module foo
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toMatch(/## Errors[\s\S]*dead code/);
  });

  it("leaves non-unused warnings in Warnings section", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: prefer const over let
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 0");
    expect(r).toContain("- Warnings: 1");
  });

  it("preserves existing errors and appends promoted lines", () => {
    const input = `## Results
- Errors: 1
- Warnings: 1

## Errors
type error in foo.ts

## Warnings
'x' is declared but never used
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 2");
    expect(r).toContain("- Warnings: 0");
    expect(r).toContain("type error in foo.ts");
    expect(r).toMatch(/declared but never used/);
  });

  it("returns input unchanged when no warnings section present", () => {
    const input = `## Results
- Errors: 1

## Errors
some error
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toBe(input);
  });
});
