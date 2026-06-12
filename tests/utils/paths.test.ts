import { describe, expect, it } from "vitest";
import { scenarioRunDir, scenariosRoot } from "../../src/utils/paths.js";

describe("scenarioRunDir", () => {
  it("rejects dot-only names that resolve to the scenarios root or its parent", () => {
    expect(() => scenarioRunDir(".")).toThrow(/invalid scenario name/);
    expect(() => scenarioRunDir("..")).toThrow(/invalid scenario name/);
  });

  it("keeps valid scenario names inside the scenarios root", () => {
    const dir = scenarioRunDir("valid_1.2-3");
    expect(dir.startsWith(scenariosRoot())).toBe(true);
    expect(dir.endsWith("/valid_1.2-3")).toBe(true);
  });
});
