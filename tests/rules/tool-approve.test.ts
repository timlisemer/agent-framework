import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

vi.mock("../../src/utils/plan-source.js", () => ({
  validateCurrentPlanExit: vi.fn(),
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
import { validateCurrentPlanExit } from "../../src/utils/plan-source.js";
import { checkPlanIntent } from "../../src/agents/hooks/plan-validate.js";
import { activeSpec } from "../../src/adapter/spec.js";
import { makeRuleContext } from "../helpers/rule-context.js";

const mockValidateCurrentPlanExit = vi.mocked(validateCurrentPlanExit);
const mockCheckPlanIntent = vi.mocked(checkPlanIntent);

describe("toolApproveRule ExitPlanMode short-circuit", () => {
  let tempDir: string;
  let planPath: string;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-approve-test-"));
    planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, "# Plan\n\nSome content.\n");
    mockValidateCurrentPlanExit.mockResolvedValue({
      approved: true,
      reason: "ok",
      source: { kind: "file", path: planPath },
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
    vi.clearAllMocks();
  });

  function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
    return makeRuleContext({
      toolName: "ExitPlanMode",
      toolInput: { plan: "# Plan" },
      projectDir: tempDir,
      transcriptPath: path.join(tempDir, "transcript.jsonl"),
      sessionDir: tempDir,
      planMode: true,
      planModeCtx: { active: true, contextString: "PLAN MODE ACTIVE" },
      ...overrides,
    });
  }

  it("returns fastAllow and does NOT invoke LLM when plan validation passes", async () => {
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastAllow: "Plan exit approved after plan validation" });
    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
  });

  it("returns fastDeny when plan file is missing", async () => {
    mockValidateCurrentPlanExit.mockResolvedValue({
      approved: false,
      reason: "Cannot exit plan mode without a plan.",
    });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Cannot exit plan mode without a plan." });
  });

  it("returns fastDeny with plan-validation reason when checkPlanIntent rejects", async () => {
    mockValidateCurrentPlanExit.mockResolvedValue({ approved: false, reason: "missing section X" });
    const result = await toolApproveRule.check(makeCtx());
    expect(result).toEqual({ fastDeny: "Plan validation failed: missing section X" });
  });
});

describe("toolApproveRule deterministic fastDeny paths", () => {
  let tempDir: string;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "claude";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-approve-det-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
    vi.clearAllMocks();
  });

  function makeCtx(overrides: Parameters<typeof makeRuleContext>[0] = {}) {
    return makeRuleContext({
      toolName: "Bash",
      toolInput: { command: "ls" },
      toolUseId: "toolu_det",
      projectDir: tempDir,
      transcriptPath: path.join(tempDir, "transcript.jsonl"),
      sessionDir: tempDir,
      ...overrides,
    });
  }

  it("fastDeny for RESTRICTED_MCP_TOOLS when no CLAUDE.md", async () => {
    const ctx = makeCtx({
      toolName: activeSpec().mcpWireName("commit"),
      toolInput: {},
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).not.toBeNull();
    expect(result).toHaveProperty("fastDeny");
    const deny = result as { fastDeny: string };
    expect(deny.fastDeny).toContain("requires explicit workflow authorization");
  });

  it("allows RESTRICTED_MCP_TOOLS when workflow authorization is active", async () => {
    const commitTool = activeSpec().mcpWireName("commit");
    const ctx = makeCtx({
      toolName: commitTool,
      toolInput: {},
      slashCommandAllowedTools: [commitTool],
    });
    const result = await toolApproveRule.check(ctx);
    expect(result).toBeNull();
  });

  it("fast-allows check MCP without injecting stale project-rule context", async () => {
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    fs.writeFileSync(
      path.join(tempDir, "CLAUDE.md"),
      [
        "## Testing MCP Server",
        "",
        "Use `mcp__agent-framework__check` to run the MCP server test.",
        "",
        "Only do this when explicitly mentioned by the user.",
        "",
      ].join("\n"),
    );
    const checkTool = activeSpec().mcpWireName("check");
    const ctx = makeCtx({
      toolName: checkTool,
      rawToolName: checkTool,
      toolInput: { working_dir: tempDir },
    });

    const result = await toolApproveRule.check(ctx);
    expect(result).toEqual({
      fastAllow: "agent-framework check MCP is always available for verification",
    });
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
