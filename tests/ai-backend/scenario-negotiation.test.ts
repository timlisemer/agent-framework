import { describe, expect, it } from "vitest";
import { negotiateScenarioHello } from "../../src/scenario/protocol/negotiation.js";

const digest = "sha256:canonical";

function hello(schemaDigests: string[]) {
  return {
    type: "hello" as const,
    client: { name: "test", version: "1" },
    capabilities: [],
    schemaDigests,
  };
}

describe("Scenario hello negotiation", () => {
  it("accepts only clients that advertise the canonical schema digest", () => {
    expect(negotiateScenarioHello(hello([digest]), digest)).toEqual({ ok: true, schemaDigest: digest });
    expect(negotiateScenarioHello(hello([]), digest)).toMatchObject({
      ok: false,
      code: "incompatible_schema",
    });
    expect(negotiateScenarioHello(hello(["sha256:older"]), digest)).toMatchObject({
      ok: false,
      code: "incompatible_schema",
    });
  });
});
