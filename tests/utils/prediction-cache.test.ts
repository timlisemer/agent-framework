import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getActivePrediction,
  savePrediction,
  clearPredictions,
  matchBlockedTool,
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
});

// The prediction-cache module uses a module-level `cacheManager` variable that is
// lazily initialized on first access. Once set, it retains its file path for the
// process lifetime. Tests below use a single shared tmpDir to avoid issues with
// the singleton cacheManager pointing to a stale directory.
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
      expectedTools: ["Bash"],
      blockedTools: [],
      userMessageSnippet: "test message",
      timestamp: Date.now(),
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
    expect(result!.expectedTools).toEqual(["Bash"]);
  });

  it("overwrites the first prediction when saving a second", async () => {
    const first = makePrediction({ userMessageSnippet: "first" });
    const second = makePrediction({ userMessageSnippet: "second" });
    await savePrediction(tmpDir, first);
    await savePrediction(tmpDir, second);
    const result = await getActivePrediction(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.userMessageSnippet).toBe("second");
  });

  it("returns null after clearing predictions", async () => {
    const prediction = makePrediction();
    await savePrediction(tmpDir, prediction);
    await clearPredictions(tmpDir);
    const result = await getActivePrediction(tmpDir);
    expect(result).toBeNull();
  });

  it("does not throw when clearing predictions on an empty directory", async () => {
    await expect(clearPredictions(tmpDir)).resolves.not.toThrow();
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
