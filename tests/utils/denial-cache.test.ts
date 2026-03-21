import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recordDenial,
  getDenialCount,
  isWorkaroundEscalation,
  clearDenialCache,
  loadDenials,
  setDenialSession,
  MAX_SIMILAR_DENIALS,
} from "../../src/utils/denial-cache.js";

describe("denial-cache", () => {
  beforeEach(async () => {
    // Isolate each test with a unique session path to avoid shared file state
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "denial-test-"));
    setDenialSession(path.join(tempDir, "session.jsonl"));
    await clearDenialCache();
  });

  describe("recordDenial / getDenialCount", () => {
    it("returns 1 for first denial of a pattern", async () => {
      const count = await recordDenial("type-check");
      expect(count).toBe(1);
    });

    it("increments count for repeated denials", async () => {
      await recordDenial("type-check");
      const count = await recordDenial("type-check");
      expect(count).toBe(2);
    });

    it("tracks separate patterns independently", async () => {
      await recordDenial("type-check");
      await recordDenial("build");
      expect(await getDenialCount("type-check")).toBe(1);
      expect(await getDenialCount("build")).toBe(1);
    });

    it("returns 0 for unknown pattern", async () => {
      expect(await getDenialCount("nonexistent")).toBe(0);
    });
  });

  describe("isWorkaroundEscalation", () => {
    it("returns false for count below threshold", async () => {
      await recordDenial("type-check");
      expect(await isWorkaroundEscalation("type-check")).toBe(false);
    });

    it("returns true when count reaches MAX_SIMILAR_DENIALS", async () => {
      for (let i = 0; i < MAX_SIMILAR_DENIALS; i++) {
        await recordDenial("type-check");
      }
      expect(await isWorkaroundEscalation("type-check")).toBe(true);
    });
  });

  describe("clearDenialCache", () => {
    it("clears all entries", async () => {
      await recordDenial("type-check");
      await recordDenial("build");
      await clearDenialCache();
      expect(await getDenialCount("type-check")).toBe(0);
      expect(await getDenialCount("build")).toBe(0);
    });
  });

  describe("loadDenials", () => {
    it("returns empty map when no denials recorded", async () => {
      const map = await loadDenials();
      expect(map.size).toBe(0);
    });

    it("returns map with recorded denials", async () => {
      await recordDenial("type-check");
      await recordDenial("type-check");
      await recordDenial("build");
      const map = await loadDenials();
      expect(map.get("type-check")?.count).toBe(2);
      expect(map.get("build")?.count).toBe(1);
    });
  });
});
