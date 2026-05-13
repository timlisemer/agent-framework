import { describe, it, expect } from "vitest";
import { parseTierName, MODEL_TIERS } from "../../src/types.js";

describe("parseTierName", () => {
  it("returns OPUS for undefined input", () => {
    expect(parseTierName(undefined)).toBe(MODEL_TIERS.OPUS);
  });

  it("returns OPUS for invalid string", () => {
    expect(parseTierName("invalid")).toBe(MODEL_TIERS.OPUS);
  });

  it("returns HAIKU for 'haiku'", () => {
    expect(parseTierName("haiku")).toBe(MODEL_TIERS.HAIKU);
  });

  it("returns SONNET for 'Sonnet' (case-insensitive)", () => {
    expect(parseTierName("Sonnet")).toBe(MODEL_TIERS.SONNET);
  });

  it("returns OPUS for 'opus'", () => {
    expect(parseTierName("opus")).toBe(MODEL_TIERS.OPUS);
  });

  it("returns OPUS for empty string", () => {
    expect(parseTierName("")).toBe(MODEL_TIERS.OPUS);
  });
});
