import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

describe("pre-tool-use planfile writes", () => {
  it("does not run plan validation on every planfile Write/Edit", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "pre-tool-use.ts"),
      "utf-8",
    );
    expect(source).not.toContain("validatePlanEdit");
    expect(source).not.toContain("runPlanValidation");
    expect(source).not.toContain("Plan-validate: Write/Edit to the active adapter's plans root.");
  });
});
