import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "os";
import * as path from "path";

vi.mock("../../src/utils/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/utils/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/transcript.js")>(
    "../../src/utils/transcript.js"
  );
  return {
    ...actual,
    readTranscriptExact: vi.fn().mockResolvedValue({ user: [], assistant: [], tool: [], totalCount: 0 }),
    formatTranscriptResult: vi.fn().mockReturnValue(""),
  };
});

vi.mock("../../src/utils/logger.js", () => ({
  logFastPathDeny: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

import { questionValidateRule } from "../../src/rules/question-validate.js";
import { runAgent } from "../../src/utils/agent-runner.js";
import { readTranscriptExact, formatTranscriptResult } from "../../src/utils/transcript.js";
import type { RuleContext } from "../../src/rules/types.js";

const mockRunAgent = vi.mocked(runAgent);
const mockReadTranscriptExact = vi.mocked(readTranscriptExact);
const mockFormatTranscriptResult = vi.mocked(formatTranscriptResult);

const tempDir = os.tmpdir();

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  return {
    toolName: "AskUserQuestion",
    toolInput: {
      questions: [
        {
          question: "Which approach do you prefer?",
          header: "Choose approach",
          options: [
            { label: "Option A", description: "Simple approach" },
            { label: "Option B", description: "Complex approach" },
          ],
          multiSelect: false,
        },
      ],
    },
    toolUseId: "toolu_test",
    projectDir: tempDir,
    transcriptPath: path.join(tempDir, "transcript.jsonl"),
    sessionDir: tempDir,
    sessionId: "test-session",
    state: {} as RuleContext["state"],
    stateManager: {} as RuleContext["stateManager"],
    planMode: false,
    planModeCtx: { active: false, contextString: "" },
    subagent: false,
    ...overrides,
  };
}

describe("questionValidateRule — deterministic null paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when toolName is not AskUserQuestion", async () => {
    const ctx = makeCtx({ toolName: "Bash" });
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when subagent is true", async () => {
    const ctx = makeCtx({ subagent: true });
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when questions array is empty", async () => {
    const ctx = makeCtx({
      toolInput: { questions: [] },
    });
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when transcript is missing (readTranscriptExact rejects)", async () => {
    mockReadTranscriptExact.mockRejectedValueOnce(new Error("file not found"));
    const ctx = makeCtx();
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when conversation is empty string after formatting", async () => {
    mockReadTranscriptExact.mockResolvedValueOnce({ user: [], assistant: [], tool: [], totalCount: 0 });
    mockFormatTranscriptResult.mockReturnValueOnce("");
    const ctx = makeCtx();
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("questionValidateRule — LLM-call paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Provide non-empty transcript so LLM is called
    mockReadTranscriptExact.mockResolvedValue({
      user: [{ role: "user" as const, content: "hello", index: 0 }],
      assistant: [],
      tool: [],
      totalCount: 1,
    });
    mockFormatTranscriptResult.mockReturnValue("User: hello");
  });

  it("returns null when runAgent returns ALLOW", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: "ALLOW",
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    const result = await questionValidateRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns fastDeny with feedback when runAgent returns BLOCK: <feedback>", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: "BLOCK: Show the plan to user first with /plan or by reading the file, then ask",
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    const result = await questionValidateRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toBe(
      "Show the plan to user first with /plan or by reading the file, then ask"
    );
  });
});
