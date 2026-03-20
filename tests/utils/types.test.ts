import { describe, it, expect } from "vitest";
import { getModelId, parseTierName, MODEL_TIERS, MODEL_IDS } from "../../src/types.js";

describe("getModelId", () => {
  it("returns correct model ID for HAIKU tier", () => {
    expect(getModelId(MODEL_TIERS.HAIKU)).toBe(MODEL_IDS.haiku);
  });

  it("returns correct model ID for SONNET tier", () => {
    expect(getModelId(MODEL_TIERS.SONNET)).toBe(MODEL_IDS.sonnet);
  });

  it("returns correct model ID for OPUS tier", () => {
    expect(getModelId(MODEL_TIERS.OPUS)).toBe(MODEL_IDS.opus);
  });
});

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
