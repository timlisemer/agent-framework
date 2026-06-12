import { describe, it, expect } from "vitest";
import { validateScenario } from "../../../src/scenario/types.js";
import { baseValidationScenario } from "../../helpers/scenario-fixtures.js";

describe("validateScenario env bypass fields", () => {
  it("rejects llm_stubs in scenario env", () => {
    const s = baseValidationScenario({ name: "test-no-llm-stubs" });
    s.env = { llm_stubs: { "rule-gate": "APPROVE" } };
    expect(() => validateScenario(s)).toThrow(
      /scenario\.env\.llm_stubs is not allowed/,
    );
  });
});
