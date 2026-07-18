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
    readTranscriptExact: vi.fn().mockResolvedValue({ user: [], assistant: [] }),
    formatTranscriptResult: vi.fn().mockReturnValue(""),
    readRecentUserMessages: vi.fn().mockResolvedValue(""),
  };
});

vi.mock("../../src/utils/logger.js", () => ({
  logFastPathDeny: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock("../../src/utils/quote-detection.js", () => ({
  stripQuotedAndPastedContent: vi.fn((s: string) => s),
  stripQuotedContent: vi.fn((s: string) => s),
}));

vi.mock("../../src/utils/sentiment-prefilter.js", () => ({
  preClassifyMood: vi.fn().mockReturnValue({ hint: null, interruptCount: 0 }),
  extractDirectiveHint: vi.fn().mockReturnValue(null),
  preClassifyCalm: vi.fn().mockReturnValue(false),
}));

import { sentimentRule } from "../../src/rules/sentiment.js";
import { runAgent } from "../../src/utils/agent-runner.js";
import { stripQuotedAndPastedContent } from "../../src/utils/quote-detection.js";
import {
  preClassifyMood,
  extractDirectiveHint,
  preClassifyCalm,
} from "../../src/utils/sentiment-prefilter.js";
import type { RuleContext } from "../../src/rules/types.js";
import { sessionStateDefaults, type SessionState } from "../helpers/session-workflow.js";
import type { CacheManager } from "../../src/utils/cache-manager.js";
import { makeRuleContext } from "../helpers/rule-context.js";
import {
  implementWorkflowRequirementSignatures,
  requirementSignature,
} from "../helpers/workflow-requirements.js";

const mockRunAgent = vi.mocked(runAgent);
const mockStripQuotedAndPastedContent = vi.mocked(stripQuotedAndPastedContent);
const mockPreClassifyMood = vi.mocked(preClassifyMood);
const mockExtractDirectiveHint = vi.mocked(extractDirectiveHint);
const mockPreClassifyCalm = vi.mocked(preClassifyCalm);

const tempDir = os.tmpdir();

// Minimal valid SENTIMENT_AGENT marker output
const VALID_SENTIMENT_OUTPUT = `---MOOD---
neutral
---TRUST---
normal
---INTENT---
User wants to fix the bug in foo.ts
---BLOCKED-INTENT---
(none)
---EXPLICITLY-ALLOWED-TOOLS---
(none)
---EXPLICITLY-REQUIRED-TOOLS---
(none)
---NON-BLOCKING-TOOLS---
(none)
---EXPLICITLY-BLOCKED---
(none)
---CONTEXT-SWITCH---
no
---QUESTION-IS-STALLING---
n/a
---BLOCK-ALL-TOOLS---
no`;

function makeState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    ...sessionStateDefaults(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
  const state = makeState();
  const updater = vi.fn().mockImplementation((fn: (s: SessionState) => SessionState) => {
    return Promise.resolve(fn(state));
  });
  const stateManager: CacheManager<SessionState> = {
    load: vi.fn().mockResolvedValue(state),
    update: updater,
  } as unknown as CacheManager<SessionState>;

  return makeRuleContext({
    hookEvent: "UserPromptSubmit",
    toolName: "",
    toolInput: {},
    toolUseId: "",
    userPrompt: "please fix the bug",
    projectDir: tempDir,
    transcriptPath: path.join(tempDir, "transcript.jsonl"),
    sessionDir: tempDir,
    sessionId: "test-session",
    state,
    stateManager,
    ...overrides,
  });
}

describe("sentimentRule - metadata", () => {
  it("exposes events: ['UserPromptSubmit']", () => {
    expect(sentimentRule.events).toEqual(["UserPromptSubmit"]);
  });
});

describe("sentimentRule - deterministic null paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when ctx.userPrompt is empty string", async () => {
    const ctx = makeCtx({ userPrompt: "" });
    const result = await sentimentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when ctx.userPrompt is undefined", async () => {
    const ctx = makeCtx({ userPrompt: undefined });
    const result = await sentimentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("sentimentRule - LLM-call path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("always returns null (side-effect rule)", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    const result = await sentimentRule.check(ctx);
    expect(result).toBeNull();
  });

  it("calls stateManager.update with a function that sets currentPrediction", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    await sentimentRule.check(ctx);

    expect(ctx.stateManager.update).toHaveBeenCalled();

    // Verify the updater function produces a state with currentPrediction populated
    const updateFn = vi.mocked(ctx.stateManager.update).mock.calls[0][0];
    const baseState = makeState();
    const updatedState = updateFn(baseState);
    expect(updatedState).toHaveProperty("currentPrediction");
    expect(updatedState.currentPrediction).not.toBeNull();
    const prediction = updatedState.currentPrediction!;
    expect(prediction).toHaveProperty("mood");
    expect(prediction).toHaveProperty("trust");
    expect(prediction).toHaveProperty("intent");
    expect(prediction).toHaveProperty("userMessageFull");
    expect(prediction).toHaveProperty("userMessageSnippet");
    expect(prediction).toHaveProperty("timestamp");
  });

  it("derives ordered workflow requirements from skill text and removes required tools from broad allows", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT.replace(
        "---EXPLICITLY-ALLOWED-TOOLS---\n(none)",
        "---EXPLICITLY-ALLOWED-TOOLS---\nAgent, TaskOutput, Read",
      ),
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const workflowText = [
      "Immediately call `mcp__agent_framework__implement`.",
      "Pass `working_dir` with the current repository working directory.",
      "Do not spawn agents yourself.",
    ].join("\n");
    const ctx = makeCtx({ userPrompt: workflowText });
    await sentimentRule.check(ctx);

    const updateFn = vi.mocked(ctx.stateManager.update).mock.calls[0][0];
    const updatedState = updateFn(makeState());
    const prediction = updatedState.currentPrediction!;
    expect(prediction.explicitlyAllowedTools).toEqual([]);
    expect(prediction.explicitlyRequiredTools?.map(requirementSignature))
      .toEqual(implementWorkflowRequirementSignatures());
    expect(prediction.nonBlockingTools).toContainEqual(
      expect.objectContaining({ tool: "Read" }),
    );
  });

  it("stores and sends the full latest user message without sentiment truncation", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const longPrompt = `${"context ".repeat(80)}now edit src/foo.ts`;
    const ctx = makeCtx({ userPrompt: longPrompt });
    await sentimentRule.check(ctx);

    const runContext = mockRunAgent.mock.calls[0][1].context;
    expect(runContext).toContain(longPrompt);
    expect(runContext).not.toContain("[truncated for sentiment latency budget]");

    const updateFn = vi.mocked(ctx.stateManager.update).mock.calls[0][0];
    const updatedState = updateFn(makeState());
    expect(updatedState.currentPrediction?.userMessageFull).toBe(longPrompt);
    expect(updatedState.currentPrediction?.userMessageSnippet).toBe(longPrompt.slice(0, 200));
    expect(updatedState.currentEditIntent).toBe(true);
  });

  it("uses stripped text for sentiment prefilters while preserving full text for intent logic", async () => {
    mockStripQuotedAndPastedContent.mockReturnValueOnce("please edit src/foo.ts");
    mockExtractDirectiveHint.mockReturnValueOnce("please edit src/foo.ts");
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const quotedHostility =
      "> fuck you why did you ignore me\n\nplease edit src/foo.ts";
    const ctx = makeCtx({ userPrompt: quotedHostility });
    await sentimentRule.check(ctx);

    expect(mockPreClassifyMood).toHaveBeenCalledWith("please edit src/foo.ts");
    expect(mockExtractDirectiveHint).toHaveBeenCalledWith("please edit src/foo.ts");
    expect(mockPreClassifyCalm).toHaveBeenCalledWith(
      "please edit src/foo.ts",
      "please edit src/foo.ts",
    );

    const runContext = mockRunAgent.mock.calls[0][1].context;
    expect(runContext).toContain(`LATEST USER MESSAGE (authoritative full unstripped text):\n${quotedHostility}`);

    const updateFn = vi.mocked(ctx.stateManager.update).mock.calls[0][0];
    const updatedState = updateFn(makeState());
    expect(updatedState.currentPrediction?.userMessageFull).toBe(quotedHostility);
    expect(updatedState.currentEditIntent).toBe(true);
  });

  it("calls stateManager.update with frustrationStreak field when LLM succeeds", async () => {
    mockRunAgent.mockResolvedValueOnce({
      output: VALID_SENTIMENT_OUTPUT,
      success: true,
      latencyMs: 100,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    await sentimentRule.check(ctx);

    const updateFn = vi.mocked(ctx.stateManager.update).mock.calls[0][0];
    const baseState = makeState();
    const updatedState = updateFn(baseState);
    expect(updatedState).toHaveProperty("frustrationStreak");
    expect(typeof updatedState.frustrationStreak).toBe("number");
  });
});
