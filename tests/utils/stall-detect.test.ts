import { describe, expect, it } from "vitest";
import { detectStallShape } from "../../src/utils/stall-detect.js";

describe("detectStallShape", () => {
  it("detects hostile passive halt without action", () => {
    expect(detectStallShape("I am waiting for you to tell me what to do.", null, true))
      .toBe("passive halt without action");
  });

  it("does not detect passive halt in non-hostile context", () => {
    expect(detectStallShape("I am waiting for you to tell me what to do.", null, false))
      .toBeNull();
  });
});
