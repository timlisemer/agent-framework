import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../../src/utils/session-utils.js", () => ({
  resolvePlanPath: vi.fn(),
  readPlanContent: vi.fn(),
}));

vi.mock("../../src/agents/hooks/plan-validate.js", () => ({
  checkPlanIntent: vi.fn(),
}));

vi.mock("../../src/agents/hooks/tool-approve.js", () => ({
  checkToolApproval: vi.fn(),
}));

vi.mock("../../src/utils/transcript.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/transcript.js")>(
    "../../src/utils/transcript.js"
  );
  return {
    ...actual,
    readTranscriptExact: vi.fn().mockResolvedValue({ user: [], assistant: [] }),
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

import { toolApproveRule } from "../../src/rules/tool-approve.js";
import { resolvePlanPath, readPlanContent } from "../../src/utils/session-utils.js";
import { checkPlanIntent } from "../../src/agents/hooks/plan-validate.js";
import { checkToolApproval } from "../../src/agents/hooks/tool-approve.js";
import type { RuleContext } from "../../src/rules/types.js";

const mockResolvePlanPath = vi.mocked(resolvePlanPath);
const mockReadPlanContent = vi.mocked(readPlanContent);
const mockCheckPlanIntent = vi.mocked(checkPlanIntent);
const mockCheckToolApproval = vi.mocked(checkToolApproval);

describe("toolApproveRule ExitPlanMode short-circuit", () => {
  let tempDir: string;
  let planPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-approve-test-"));
    planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, "# Plan\n\nSome content.\n");
    mockResolvePlanPath.mockResolvedValue(planPath);
    mockReadPlanContent.mockResolvedValue("# Plan\n\nSome content.\n");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      toolName: "ExitPlanMode",
      toolInput: { plan: "# Plan" },
      toolUseId: "toolu_test",
      projectDir: tempDir,
      transcriptPath: path.join(tempDir, "transcript.jsonl"),
      sessionDir: tempDir,
      sessionId: "test-session",
      state: {} as RuleContext["state"],
      stateManager: {} as RuleContext["stateManager"],
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      subagent: false,
      toolCallCount: 1,
      ...overrides,
    };
  }

  it("returns fastAllow and does NOT invoke tool-approve LLM when plan validation passes", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true, reason: "ok" });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastAllow: "ExitPlanMode approved after plan validation" });
    expect(mockCheckToolApproval).not.toHaveBeenCalled();
  });

  it("returns fastDeny when plan file is missing", async () => {
    mockResolvePlanPath.mockResolvedValue(null);
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Cannot exit plan mode without a plan." });
    expect(mockCheckToolApproval).not.toHaveBeenCalled();
  });

  it("returns fastDeny with plan-validation reason when checkPlanIntent rejects", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: false, reason: "missing section X" });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Plan validation failed: missing section X" });
    expect(mockCheckToolApproval).not.toHaveBeenCalled();
  });
});
