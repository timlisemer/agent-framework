import { describe, it, expect } from "vitest";
import { validateScenario } from "../../../src/scenario/types.js";
import { baseValidationScenario } from "../../helpers/scenario-fixtures.js";

function baseScenario(): Record<string, unknown> {
  return baseValidationScenario({
    name: "test-plan-file",
    seedState: {
      planFile: { slug: "test-slug-1", content: "# Plan\n..." },
    },
  });
}

describe("validateScenario seed_state.planFile", () => {
  it("accepts a valid slug", () => {
    expect(() => validateScenario(baseScenario())).not.toThrow();
  });

  it("accepts an empty content string", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
      content: "",
    };
    expect(() => validateScenario(s)).not.toThrow();
  });

  it("rejects slug = '../etc'", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "../etc",
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.slug must match lowercase kebab-case/);
  });

  it("rejects slug with space", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "has space",
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.slug must match lowercase kebab-case/);
  });

  it("rejects missing slug field", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      content: "x",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.slug must match/);
  });

  it("rejects missing content field", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
    };
    expect(() => validateScenario(s)).toThrow(/planFile.content must be a string/);
  });

  it("rejects unknown sub-fields", () => {
    const s = baseScenario();
    (s.seed_state as { planFile: Record<string, unknown> }).planFile = {
      slug: "ok",
      content: "",
      bogus: 1,
    };
    expect(() => validateScenario(s)).toThrow(
      /planFile.bogus is not a recognized field/,
    );
  });

  it("unknown_field rejection under seed_state still fires", () => {
    const s = baseScenario();
    (s.seed_state as Record<string, unknown>).unknown_field = "x";
    expect(() => validateScenario(s)).toThrow(
      /seed_state.unknown_field is not a recognized field/,
    );
  });
});
