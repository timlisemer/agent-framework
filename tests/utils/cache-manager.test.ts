import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { CacheManager, getTempFilePath } from "../../src/utils/cache-manager.js";

interface TestEntry {
  id: string;
  value: number;
  timestamp: number;
}

interface TestData {
  entries: TestEntry[];
}

function createTestManager(filePath: string, options?: {
  expiryMs?: number;
  maxEntries?: number;
}): CacheManager<TestData> {
  return new CacheManager<TestData>({
    filePath,
    defaultData: () => ({ entries: [] }),
    expiryMs: options?.expiryMs,
    maxEntries: options?.maxEntries,
    getTimestamp: (e) => (e as TestEntry).timestamp,
    getEntries: (d) => d.entries,
    setEntries: (d, e) => ({ ...d, entries: e as TestEntry[] }),
  });
}

describe("CacheManager", () => {
  let tempDir: string;
  let cacheFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
    cacheFile = path.join(tempDir, "test-cache.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("load", () => {
    it("returns default data when file does not exist", async () => {
      const manager = createTestManager(cacheFile);
      const data = await manager.load();
      expect(data).toEqual({ entries: [] });
    });

    it("returns default data when file is corrupted JSON", async () => {
      fs.writeFileSync(cacheFile, "not valid json{{{");
      const manager = createTestManager(cacheFile);
      const data = await manager.load();
      expect(data).toEqual({ entries: [] });
    });

    it("returns saved data after save", async () => {
      const manager = createTestManager(cacheFile);
      const testData: TestData = { entries: [{ id: "a", value: 1, timestamp: Date.now() }] };
      await manager.save(testData);

      const loaded = await manager.load();
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].id).toBe("a");
    });

    it("returns default data when session ID changed", async () => {
      const manager1 = createTestManager(cacheFile);
      manager1.setSession("session-1");
      await manager1.save({ entries: [{ id: "a", value: 1, timestamp: Date.now() }] });

      const manager2 = createTestManager(cacheFile);
      manager2.setSession("session-2");
      const loaded = await manager2.load();
      expect(loaded).toEqual({ entries: [] });
    });

    it("applies time expiry to entries", async () => {
      const manager = createTestManager(cacheFile, { expiryMs: 100 });
      const oldEntry: TestEntry = { id: "old", value: 1, timestamp: Date.now() - 200 };
      const newEntry: TestEntry = { id: "new", value: 2, timestamp: Date.now() };
      await manager.save({ entries: [oldEntry, newEntry] });

      const loaded = await manager.load();
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0].id).toBe("new");
    });

    it("applies max entries limit", async () => {
      const manager = createTestManager(cacheFile, { maxEntries: 2 });
      const entries: TestEntry[] = [
        { id: "a", value: 1, timestamp: 1 },
        { id: "b", value: 2, timestamp: 2 },
        { id: "c", value: 3, timestamp: 3 },
      ];
      await manager.save({ entries });

      const loaded = await manager.load();
      expect(loaded.entries).toHaveLength(2);
      expect(loaded.entries[0].id).toBe("b");
      expect(loaded.entries[1].id).toBe("c");
    });
  });

  describe("save", () => {
    it("creates file that can be loaded back", async () => {
      const manager = createTestManager(cacheFile);
      await manager.save({ entries: [{ id: "test", value: 42, timestamp: Date.now() }] });

      expect(fs.existsSync(cacheFile)).toBe(true);
      const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      expect(raw.data.entries[0].id).toBe("test");
    });

    it("preserves session ID and user message hash", async () => {
      const manager = createTestManager(cacheFile);
      manager.setSession("my-session");
      await manager.checkUserMessage("hello user");
      await manager.save({ entries: [] });

      const raw = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
      expect(raw.sessionId).toBe("my-session");
      expect(raw.lastUserMessageHash).toBeDefined();
    });
  });

  describe("update", () => {
    it("applies transform function to loaded data", async () => {
      const manager = createTestManager(cacheFile);
      await manager.save({ entries: [{ id: "a", value: 1, timestamp: Date.now() }] });

      await manager.update((data) => ({
        entries: [...data.entries, { id: "b", value: 2, timestamp: Date.now() }],
      }));

      const loaded = await manager.load();
      expect(loaded.entries).toHaveLength(2);
    });
  });

  describe("clear", () => {
    it("removes cache file", async () => {
      const manager = createTestManager(cacheFile);
      await manager.save({ entries: [{ id: "a", value: 1, timestamp: Date.now() }] });
      expect(fs.existsSync(cacheFile)).toBe(true);

      await manager.clear();
      expect(fs.existsSync(cacheFile)).toBe(false);
    });

    it("load returns default after clear", async () => {
      const manager = createTestManager(cacheFile);
      await manager.save({ entries: [{ id: "a", value: 1, timestamp: Date.now() }] });
      await manager.clear();

      const loaded = await manager.load();
      expect(loaded).toEqual({ entries: [] });
    });
  });

  describe("checkUserMessage", () => {
    it("returns false when no previous hash exists", async () => {
      const manager = createTestManager(cacheFile);
      const result = await manager.checkUserMessage("hello");
      expect(result).toBe(false);
    });

    it("returns true and clears when hash changes", async () => {
      const manager = createTestManager(cacheFile);
      await manager.checkUserMessage("first message");
      await manager.save({ entries: [{ id: "a", value: 1, timestamp: Date.now() }] });

      const result = await manager.checkUserMessage("second message");
      expect(result).toBe(true);
    });

    it("returns false when hash is the same", async () => {
      const manager = createTestManager(cacheFile);
      await manager.checkUserMessage("same message");
      await manager.save({ entries: [] });

      const result = await manager.checkUserMessage("same message");
      expect(result).toBe(false);
    });

    it("returns false for undefined message", async () => {
      const manager = createTestManager(cacheFile);
      const result = await manager.checkUserMessage(undefined);
      expect(result).toBe(false);
    });
  });
});

describe("getTempFilePath", () => {
  it("returns path within agent-framework temp directory", () => {
    const result = getTempFilePath("test-file.json");
    expect(result).toContain("agent-framework");
    expect(result).toContain("test-file.json");
  });
});
