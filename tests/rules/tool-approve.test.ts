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
import type { RuleContext } from "../../src/rules/types.js";

const mockResolvePlanPath = vi.mocked(resolvePlanPath);
const mockReadPlanContent = vi.mocked(readPlanContent);
const mockCheckPlanIntent = vi.mocked(checkPlanIntent);

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
      ...overrides,
    };
  }

  it("returns fastAllow and does NOT invoke LLM when plan validation passes", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true, reason: "ok" });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastAllow: "ExitPlanMode approved after plan validation" });
  });

  it("returns fastDeny when plan file is missing", async () => {
    mockResolvePlanPath.mockResolvedValue(null);
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Cannot exit plan mode without a plan." });
  });

  it("returns fastDeny with plan-validation reason when checkPlanIntent rejects", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: false, reason: "missing section X" });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Plan validation failed: missing section X" });
  });
});

describe("toolApproveRule deterministic fastDeny paths", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-approve-det-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  function makeCtx(overrides: Partial<RuleContext> = {}): RuleContext {
    return {
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "toolu_det",
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

  it("fastDeny for RESTRICTED_MCP_TOOLS when no CLAUDE.md", async () => {
    const ctx = makeCtx({
      toolName: "mcp__agent-framework__commit",
      toolInput: {},
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("requires explicit workflow authorization");
  });

  it("allows RESTRICTED_MCP_TOOLS when workflow authorization is active", async () => {
    const ctx = makeCtx({
      toolName: "mcp__agent-framework__commit",
      toolInput: {},
      slashCommandAllowedTools: ["mcp__agent-framework__commit"],
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).toBeNull();
  });

  it("returns null (no contribution) when no CLAUDE.md exists and no blacklist hit", async () => {
    const ctx = makeCtx({
      toolName: "Read",
      toolInput: { file_path: path.join(tempDir, "somefile.ts") },
    });
    // No CLAUDE.md in tempDir → rulesText is empty → return null
    const result = await toolApproveRule.check(ctx);
    expect(result).toBeNull();
  });

  it("contributes llmContext when CLAUDE.md exists", async () => {
    fs.writeFileSync(path.join(tempDir, "CLAUDE.md"), "# Rules\n\nDo not do bad things.");
    const ctx = makeCtx({
      toolName: "Read",
      toolInput: { file_path: path.join(tempDir, "somefile.ts") },
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("llmContext");
    const llm = result as { llmContext: string };
    expect(llm.llmContext).toContain("PROJECT RULES (from CLAUDE.md):");
    expect(llm.llmContext).toContain("TOOL TO EVALUATE:");
  });

  it("fastDeny planMode edit block when planModeCtx is active", async () => {
    const ctx = makeCtx({
      toolName: "Edit",
      toolInput: { file_path: path.join(tempDir, "src/foo.ts"), old_string: "a", new_string: "b" },
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
  });
});
