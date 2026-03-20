import { describe, it, expect } from "vitest";
import { hashString } from "../../src/utils/hash-utils.js";

describe("hashString", () => {
  it("returns an 8-character hex string", () => {
    const result = hashString("hello");
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is deterministic (same input produces same output)", () => {
    expect(hashString("test-input")).toBe(hashString("test-input"));
  });

  it("produces different hashes for different inputs", () => {
    expect(hashString("input-a")).not.toBe(hashString("input-b"));
  });

  it("handles empty string input", () => {
    const result = hashString("");
    expect(result).toHaveLength(8);
    expect(result).toMatch(/^[0-9a-f]{8}$/);
  });
});
