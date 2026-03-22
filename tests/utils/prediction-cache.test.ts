import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getActivePrediction,
  getAllPredictions,
  savePrediction,
  deactivatePrediction,
  deactivateAllPredictions,
  matchBlockedTool,
  formatPredictionContext,
  initPredictionSession,
  type BlockedTool,
  type ToolPrediction,
} from "../../src/utils/prediction-cache.js";

describe("matchBlockedTool", () => {
  it("returns the BlockedTool on exact toolName match with no targetPattern", () => {
    const blocked: BlockedTool = { toolName: "Bash", reason: "dangerous" };
    const result = matchBlockedTool("Bash", { command: "rm -rf /" }, [blocked]);
    expect(result).toBe(blocked);
  });

  it("returns the BlockedTool when toolName matches and targetPattern glob matches command", () => {
    const blocked: BlockedTool = { toolName: "Bash", targetPattern: "git *", reason: "no git" };
    const result = matchBlockedTool("Bash", { command: "git push origin main" }, [blocked]);
    expect(result).toBe(blocked);
  });

  it("returns null for non-matching tool name", () => {
    const blocked: BlockedTool = { toolName: "Edit", reason: "no edits" };
    const result = matchBlockedTool("Bash", { command: "ls" }, [blocked]);
    expect(result).toBeNull();
  });

  it("returns null when toolName matches but targetPattern does not match command", () => {
    const blocked: BlockedTool = { toolName: "Bash", targetPattern: "git *", reason: "no git" };
    const result = matchBlockedTool("Bash", { command: "npm install" }, [blocked]);
    expect(result).toBeNull();
  });

  it("returns null for empty blockedTools array", () => {
    const result = matchBlockedTool("Bash", { command: "echo hello" }, []);
    expect(result).toBeNull();
  });

  describe("regex patterns", () => {
    it("matches all tools with .* pattern", () => {
      const blocked: BlockedTool = { toolName: ".*", reason: "block all" };
      expect(matchBlockedTool("Bash", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Read", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Edit", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Agent", {}, [blocked])).toBe(blocked);
    });

    it("respects exceptions on wildcard pattern", () => {
      const blocked: BlockedTool = {
        toolName: ".*",
        reason: "block all except Agent",
        exceptions: ["Agent"],
      };
      expect(matchBlockedTool("Bash", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Read", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Edit", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Agent", {}, [blocked])).toBeNull();
    });

    it("supports alternation pattern", () => {
      const blocked: BlockedTool = { toolName: "Edit|Write", reason: "no writes" };
      expect(matchBlockedTool("Edit", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Write", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Read", {}, [blocked])).toBeNull();
    });

    it("falls back to exact match on invalid regex", () => {
      const blocked: BlockedTool = { toolName: "[invalid", reason: "bad regex" };
      expect(matchBlockedTool("[invalid", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Bash", {}, [blocked])).toBeNull();
    });

    it("supports multiple exceptions", () => {
      const blocked: BlockedTool = {
        toolName: ".*",
        reason: "block all",
        exceptions: ["Agent", "Read"],
      };
      expect(matchBlockedTool("Agent", {}, [blocked])).toBeNull();
      expect(matchBlockedTool("Read", {}, [blocked])).toBeNull();
      expect(matchBlockedTool("Edit", {}, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Bash", {}, [blocked])).toBe(blocked);
    });

    it("combines regex pattern with targetPattern", () => {
      const blocked: BlockedTool = {
        toolName: "Bash",
        targetPattern: "git push*",
        reason: "no pushing",
      };
      expect(matchBlockedTool("Bash", { command: "git push origin main" }, [blocked])).toBe(blocked);
      expect(matchBlockedTool("Bash", { command: "git status" }, [blocked])).toBeNull();
    });
  });
});

describe("formatPredictionContext", () => {
  it("formats expectedIntent and blockedIntent", () => {
    const prediction: ToolPrediction = {
      expectedIntent: "read-only exploration tools",
      blockedIntent: "no write/edit tools",
      blockedTools: [],
      userMessageSnippet: "test",
      timestamp: Date.now(),
      active: true,
    };
    const result = formatPredictionContext(prediction);
    expect(result).toContain("Expected intent: read-only exploration tools");
    expect(result).toContain("Blocked intent: no write/edit tools");
  });

  it("includes mechanically blocked tools with exceptions", () => {
    const prediction: ToolPrediction = {
      expectedIntent: "explore agent delegation only",
      blockedIntent: "everything except Agent",
      blockedTools: [{ toolName: ".*", reason: "block all", exceptions: ["Agent"] }],
      userMessageSnippet: "test",
      timestamp: Date.now(),
      active: true,
    };
    const result = formatPredictionContext(prediction);
    expect(result).toContain("Mechanically blocked: .* (except Agent)");
  });

  it("omits empty fields", () => {
    const prediction: ToolPrediction = {
      expectedIntent: "",
      blockedIntent: "",
      blockedTools: [],
      userMessageSnippet: "test",
      timestamp: Date.now(),
      active: true,
    };
    const result = formatPredictionContext(prediction);
    expect(result).toBe("");
  });
});

describe("prediction-cache I/O", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prediction-test-"));
    initPredictionSession(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makePrediction(overrides: Partial<ToolPrediction> = {}): ToolPrediction {
    return {
      expectedIntent: "read-only exploration tools",
      blockedIntent: "",
      blockedTools: [],
      userMessageSnippet: "test message",
      timestamp: Date.now(),
      active: true,
      ...overrides,
    };
  }

  it("returns null when no prediction has been saved", async () => {
    const result = await getActivePrediction(tmpDir);
    expect(result).toBeNull();
  });

  it("saves and retrieves a prediction successfully", async () => {
    const prediction = makePrediction({ userMessageSnippet: "run tests" });
    await savePrediction(tmpDir, prediction);
    const result = await getActivePrediction(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.userMessageSnippet).toBe("run tests");
    expect(result!.expectedIntent).toBe("read-only exploration tools");
  });

  it("appends entries instead of replacing", async () => {
    const first = makePrediction({ userMessageSnippet: "first" });
    const second = makePrediction({ userMessageSnippet: "second" });
    await savePrediction(tmpDir, first);
    await savePrediction(tmpDir, second);

    const active = await getActivePrediction(tmpDir);
    expect(active).not.toBeNull();
    expect(active!.userMessageSnippet).toBe("second");

    const all = await getAllPredictions(tmpDir);
    expect(all).toHaveLength(2);
    expect(all[0].userMessageSnippet).toBe("first");
    expect(all[1].userMessageSnippet).toBe("second");
  });

  it("returns null after deactivating all predictions", async () => {
    await savePrediction(tmpDir, makePrediction());
    await savePrediction(tmpDir, makePrediction({ userMessageSnippet: "second" }));
    await deactivateAllPredictions(tmpDir);
    const result = await getActivePrediction(tmpDir);
    expect(result).toBeNull();
    const all = await getAllPredictions(tmpDir);
    expect(all).toHaveLength(0);
  });

  it("deactivatePrediction only deactivates the entry whose blockedTools match", async () => {
    const pred1 = makePrediction({
      userMessageSnippet: "first",
      blockedTools: [{ toolName: "Bash", reason: "no bash" }],
    });
    const pred2 = makePrediction({
      userMessageSnippet: "second",
      blockedTools: [{ toolName: "Edit", reason: "no edits" }],
    });
    await savePrediction(tmpDir, pred1);
    await savePrediction(tmpDir, pred2);

    await deactivatePrediction(tmpDir, "Bash", { command: "ls" });

    const all = await getAllPredictions(tmpDir);
    expect(all).toHaveLength(1);
    expect(all[0].userMessageSnippet).toBe("second");

    const active = await getActivePrediction(tmpDir);
    expect(active).not.toBeNull();
    expect(active!.userMessageSnippet).toBe("second");
  });

  it("does not throw when deactivating predictions on an empty directory", async () => {
    await expect(deactivateAllPredictions(tmpDir)).resolves.not.toThrow();
  });

  it("returns null for expired predictions (timestamp older than 10 minutes)", async () => {
    const expiredPrediction = makePrediction({
      timestamp: Date.now() - (11 * 60 * 1000), // 11 minutes ago
    });
    await savePrediction(tmpDir, expiredPrediction);
    // Re-init to force a fresh load that applies expiry
    initPredictionSession(tmpDir);
    const result = await getActivePrediction(tmpDir);
    expect(result).toBeNull();
  });

  it("returns prediction when timestamp is within 10 minutes", async () => {
    const freshPrediction = makePrediction({
      timestamp: Date.now() - (5 * 60 * 1000), // 5 minutes ago
    });
    await savePrediction(tmpDir, freshPrediction);
    initPredictionSession(tmpDir);
    const result = await getActivePrediction(tmpDir);
    expect(result).not.toBeNull();
  });

  it("getAllPredictions returns empty array when none saved", async () => {
    const all = await getAllPredictions(tmpDir);
    expect(all).toEqual([]);
  });

  it("getActivePrediction returns the most recent entry", async () => {
    await savePrediction(tmpDir, makePrediction({ userMessageSnippet: "first" }));
    await savePrediction(tmpDir, makePrediction({ userMessageSnippet: "second" }));
    await savePrediction(tmpDir, makePrediction({ userMessageSnippet: "third" }));

    const active = await getActivePrediction(tmpDir);
    expect(active!.userMessageSnippet).toBe("third");

    const all = await getAllPredictions(tmpDir);
    expect(all).toHaveLength(3);
  });

  it("matchBlockedTool with no targetPattern matches all invocations", async () => {
    const blocked: BlockedTool = { toolName: "Bash", reason: "no bash" };
    const result = matchBlockedTool("Bash", { command: "any command" }, [blocked]);
    expect(result).toBe(blocked);
  });

  it("matchBlockedTool returns null when toolName matches but targetPattern does not match file_path", () => {
    const blocked: BlockedTool = { toolName: "Edit", targetPattern: "src/*", reason: "no src" };
    const result = matchBlockedTool("Edit", { file_path: "lib/utils.ts" }, [blocked]);
    expect(result).toBeNull();
  });
});
