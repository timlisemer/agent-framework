import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  recordUserMessage,
  detectRewind,
  invalidateAllCaches,
  initRewindSession,
} from "../../src/utils/rewind-cache.js";
import { initDenialSession } from "../../src/utils/denial-cache.js";

describe("rewind-cache", () => {
  let tempDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rewind-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    initDenialSession(tempDir);
    initRewindSession(tempDir);
    await invalidateAllCaches();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("detectRewind", () => {
    it("returns false when no messages recorded", async () => {
      fs.writeFileSync(transcriptPath, "some content\n");
      expect(await detectRewind(transcriptPath)).toBe(false);
    });

    it("returns false when all cached messages exist in transcript", async () => {
      const message = "Please fix the bug in auth module";
      fs.writeFileSync(transcriptPath, `{"content": "${message}"}\n`);

      await recordUserMessage(message, 0);
      expect(await detectRewind(transcriptPath)).toBe(false);
    });

    it("returns true when a cached message is missing from transcript", async () => {
      const message = "Please fix the bug in auth module";
      // First, record the message
      await recordUserMessage(message, 0);

      // Write transcript without the message snippet
      fs.writeFileSync(transcriptPath, '{"content": "something completely different"}\n');

      expect(await detectRewind(transcriptPath)).toBe(true);
    });
  });

  describe("recordUserMessage", () => {
    it("does not record empty messages", async () => {
      fs.writeFileSync(transcriptPath, "content\n");
      await recordUserMessage("", 0);
      // detectRewind should return false since nothing was recorded
      expect(await detectRewind(transcriptPath)).toBe(false);
    });

    it("does not record duplicate messages", async () => {
      const message = "Fix the tests";
      fs.writeFileSync(transcriptPath, `has: ${message}\n`);
      await recordUserMessage(message, 0);
      await recordUserMessage(message, 1);
      // Even though we recorded twice, it should only be one entry
      // (detectRewind behavior validates this indirectly)
      expect(await detectRewind(transcriptPath)).toBe(false);
    });
  });
});
