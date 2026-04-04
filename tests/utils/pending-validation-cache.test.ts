import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  initCorrectionSession,
  writeCorrection,
  getUnconsumedCorrections,
  consumeCorrections,
  clearCorrections,
} from "../../src/utils/correction-cache.js";

describe("correction-cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "correction-cache-test-"));
    initCorrectionSession(tempDir);
    await clearCorrections(tempDir);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("getUnconsumedCorrections", () => {
    it("returns empty array when no corrections exist", async () => {
      expect(await getUnconsumedCorrections(tempDir)).toEqual([]);
    });

    it("returns unconsumed corrections", async () => {
      await writeCorrection(tempDir, {
        toolName: "Edit",
        toolTarget: "/src/main.ts",
        reason: "Violated prediction",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      const result = await getUnconsumedCorrections(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe("Edit");
      expect(result[0].reason).toBe("Violated prediction");
    });

    it("does not return consumed corrections", async () => {
      await writeCorrection(tempDir, {
        toolName: "Edit",
        toolTarget: "/src/main.ts",
        reason: "Violated prediction",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      await consumeCorrections(tempDir);
      expect(await getUnconsumedCorrections(tempDir)).toEqual([]);
    });
  });

  describe("writeCorrection", () => {
    it("stores correction that can be retrieved", async () => {
      await writeCorrection(tempDir, {
        toolName: "Bash",
        toolTarget: "git push",
        reason: "Blocked command",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      const result = await getUnconsumedCorrections(tempDir);
      expect(result).toHaveLength(1);
      expect(result[0].toolName).toBe("Bash");
    });

    it("supports multiple corrections", async () => {
      await writeCorrection(tempDir, {
        toolName: "Edit",
        toolTarget: "/src/a.ts",
        reason: "Reason 1",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      await writeCorrection(tempDir, {
        toolName: "Write",
        toolTarget: "/src/b.ts",
        reason: "Reason 2",
        source: "summary-actions",
        timestamp: Date.now(),
        consumed: false,
      });
      const result = await getUnconsumedCorrections(tempDir);
      expect(result).toHaveLength(2);
    });
  });

  describe("clearCorrections", () => {
    it("clears all corrections", async () => {
      await writeCorrection(tempDir, {
        toolName: "Edit",
        toolTarget: "/src/file.ts",
        reason: "Test",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      await clearCorrections(tempDir);
      expect(await getUnconsumedCorrections(tempDir)).toEqual([]);
    });
  });

  describe("consumeCorrections", () => {
    it("marks all corrections as consumed", async () => {
      await writeCorrection(tempDir, {
        toolName: "Edit",
        toolTarget: "/src/file.ts",
        reason: "Test",
        source: "post-tool",
        timestamp: Date.now(),
        consumed: false,
      });
      await consumeCorrections(tempDir);
      expect(await getUnconsumedCorrections(tempDir)).toEqual([]);
    });
  });
});
