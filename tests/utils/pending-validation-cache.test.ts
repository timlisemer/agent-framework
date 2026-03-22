import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkPendingValidation,
  writePendingValidation,
  clearPendingValidation,
  getPendingValidationStatus,
  initValidationSession,
} from "../../src/utils/pending-validation-cache.js";

describe("pending-validation-cache", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pending-validation-test-"));
    initValidationSession(tempDir);
    await clearPendingValidation();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("checkPendingValidation", () => {
    it("returns null when no validation stored", async () => {
      expect(await checkPendingValidation()).toBeNull();
    });

    it("returns null for passed validation", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/main.ts",
        status: "passed",
      });
      expect(await checkPendingValidation()).toBeNull();
    });

    it("returns failed validation", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/main.ts",
        status: "failed",
        failureReason: "Style drift detected",
      });
      const result = await checkPendingValidation();
      expect(result).not.toBeNull();
      expect(result!.status).toBe("failed");
      expect(result!.failureReason).toBe("Style drift detected");
    });

    it("returns null when user message hash changed (stale)", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/main.ts",
        status: "failed",
        failureReason: "Drift",
        userMessageHash: "hash-1",
      });
      expect(await checkPendingValidation("hash-2")).toBeNull();
    });

    it("returns validation when user message hash matches", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/main.ts",
        status: "failed",
        failureReason: "Drift",
        userMessageHash: "hash-1",
      });
      const result = await checkPendingValidation("hash-1");
      expect(result).not.toBeNull();
    });
  });

  describe("writePendingValidation", () => {
    it("stores validation that can be retrieved", async () => {
      await writePendingValidation({
        toolName: "Bash",
        filePath: "",
        status: "failed",
        failureReason: "Blocked command",
      });
      const result = await getPendingValidationStatus();
      expect(result).not.toBeNull();
      expect(result!.toolName).toBe("Bash");
    });

    it("adds timestamp automatically", async () => {
      const before = Date.now();
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/file.ts",
        status: "pending",
      });
      const result = await getPendingValidationStatus();
      expect(result!.timestamp).toBeGreaterThanOrEqual(before);
      expect(result!.timestamp).toBeLessThanOrEqual(Date.now());
    });
  });

  describe("clearPendingValidation", () => {
    it("clears stored validation", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/file.ts",
        status: "failed",
        failureReason: "Test",
      });
      await clearPendingValidation();
      expect(await getPendingValidationStatus()).toBeNull();
    });
  });

  describe("getPendingValidationStatus", () => {
    it("returns validation regardless of status", async () => {
      await writePendingValidation({
        toolName: "Edit",
        filePath: "/src/file.ts",
        status: "pending",
      });
      const result = await getPendingValidationStatus();
      expect(result).not.toBeNull();
      expect(result!.status).toBe("pending");
    });
  });
});
