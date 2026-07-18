import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../src/utils/agent-runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../../src/utils/git-utils.js", () => ({
  getUncommittedChangesCancellable: vi.fn(),
}));

vi.mock("../../src/utils/plan-source.js", () => ({
  readCurrentPlanContent: vi.fn().mockResolvedValue(null),
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

import { validateIntentRule } from "../../src/rules/validate-intent.js";
import { runAgent } from "../../src/utils/agent-runner.js";
import { getUncommittedChangesCancellable } from "../../src/utils/git-utils.js";
import { readTranscriptExact } from "../../src/utils/transcript.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const mockRunAgent = vi.mocked(runAgent);
const mockGetUncommittedChanges = vi.mocked(getUncommittedChangesCancellable);
const mockReadTranscriptExact = vi.mocked(readTranscriptExact);

function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
  return makeRuleContext({
    toolName: "mcp-validate_intent",
    rawToolName: undefined,
    toolInput: {},
    ...overrides,
  });
}

describe("validateIntentRule - deterministic null paths", () => {
  const prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;

  beforeEach(() => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  it("returns null when toolName does not match validate_intent", async () => {
    const ctx = makeCtx({ toolName: "Edit" });
    const result = await validateIntentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when transcript has no user messages", async () => {
    mockReadTranscriptExact.mockResolvedValueOnce({ user: [], assistant: [], tool: [], totalCount: 0 });
    const ctx = makeCtx();
    const result = await validateIntentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when readTranscriptExact rejects", async () => {
    mockReadTranscriptExact.mockRejectedValueOnce(new Error("not found"));
    const ctx = makeCtx();
    const result = await validateIntentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });

  it("returns null when there is no diff and no status", async () => {
    mockReadTranscriptExact.mockResolvedValueOnce({
      user: [{ role: "user" as const, content: "fix the bug", index: 0 }],
      assistant: [{ role: "assistant" as const, content: "OK, I'll fix it", index: 1 }],
      tool: [],
      totalCount: 2,
    });
    mockGetUncommittedChanges.mockResolvedValueOnce({
      status: "",
      diff: "",
      diffStat: "",
      untrackedInventory: "",
      untrackedLinesChanged: 0,
    });
    const ctx = makeCtx();
    const result = await validateIntentRule.check(ctx);
    expect(result).toBeNull();
    expect(mockRunAgent).not.toHaveBeenCalled();
  });
});

describe("validateIntentRule - LLM-call path", () => {
  const prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;

  beforeEach(() => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    vi.clearAllMocks();
    mockReadTranscriptExact.mockResolvedValue({
      user: [{ role: "user" as const, content: "fix the bug", index: 0 }],
      assistant: [{ role: "assistant" as const, content: "OK, I'll fix it", index: 1 }],
      tool: [],
      totalCount: 2,
    });
    mockGetUncommittedChanges.mockResolvedValue({
      status: "M src/foo.ts",
      diff: "diff --git a/src/foo.ts b/src/foo.ts\n+const fixed = true;",
      diffStat: " src/foo.ts | 1 +",
      untrackedInventory: "",
      untrackedLinesChanged: 0,
    });
  });

  afterEach(() => {
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  it("returns fastDeny with the full runAgent output (preserving ## Verdict envelope)", async () => {
    const verdictText =
      "## Analysis\n- Request: Fix the bug\n- Plan: No plan\n- Changes: One line fixed\n\n## Verdict\nALIGNED: Changes implement the requested bug fix";
    mockRunAgent.mockResolvedValueOnce({
      output: verdictText,
      success: true,
      latencyMs: 200,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    const result = await validateIntentRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toBe(verdictText);
    expect(deny.fastDeny).toContain("## Verdict");
    expect(deny.fastDeny).toContain("ALIGNED");
  });

  it("returns fastDeny containing DRIFTED verdict when agent returns drift", async () => {
    const verdictText =
      "## Analysis\n- Request: Fix login bug\n- Plan: No plan\n- Changes: Refactored database schema\n\n## Verdict\nDRIFTED: User asked to fix login bug but AI refactored database schema instead";
    mockRunAgent.mockResolvedValueOnce({
      output: verdictText,
      success: true,
      latencyMs: 200,
      errorCount: 0,
      modelTier: "haiku" as never,
      modelName: "claude-haiku-4-5",
    });
    const ctx = makeCtx();
    const result = await validateIntentRule.check(ctx);
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("DRIFTED");
  });
});
