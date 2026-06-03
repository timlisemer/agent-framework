import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tools: new Map<string, { config: unknown; handler: (args: any, extra: any) => Promise<any> }>(),
  mcpServerInstance: {
    server: { elicitInput: vi.fn() },
    registerTool: vi.fn((name: string, config: unknown, handler: (args: any, extra: any) => Promise<any>) => {
      mocks.tools.set(name, { config, handler });
    }),
    registerResource: vi.fn(),
    connect: vi.fn(),
  },
  runCheckAgent: vi.fn(),
  runValidatePlanAgent: vi.fn(),
  runCreatePlanfileAgent: vi.fn(),
  runConfirmAgent: vi.fn(),
  runCommitAgent: vi.fn(),
  runCommitAgentWithSharedConfirm: vi.fn(),
  runPushAgent: vi.fn(),
  runTranscriptAgent: vi.fn(),
  runLocateScenarioMcp: vi.fn(),
  evaluateRules: vi.fn(),
  getSessionState: vi.fn(),
  getAgentFrameworkSessionDir: vi.fn(),
  handleScenarioLabeler: vi.fn(),
  handleScenarioTester: vi.fn(),
  getRepoInfo: vi.fn(),
  getRepoInfoCancellable: vi.fn(),
  sortReposWithChangesSubmodulesFirst: vi.fn(),
  elicitRepoSelection: vi.fn(),
  elicitRepoScope: vi.fn(),
  elicitPreferences: vi.fn(),
  sortReposSubmodulesFirst: vi.fn(),
  parseUncertainties: vi.fn(),
  elicitUncertaintyClarification: vi.fn(),
  initializeTelemetry: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn(function McpServer() {
    return mocks.mcpServerInstance;
  }),
}));

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock("../../src/agents/mcp/check.js", () => ({
  runCheckAgent: mocks.runCheckAgent,
}));

vi.mock("../../src/agents/mcp/validate-plan.js", () => ({
  runValidatePlanAgent: mocks.runValidatePlanAgent,
}));

vi.mock("../../src/agents/mcp/create-planfile.js", () => ({
  runCreatePlanfileAgent: mocks.runCreatePlanfileAgent,
}));

vi.mock("../../src/agents/mcp/confirm.js", () => ({
  runConfirmAgent: mocks.runConfirmAgent,
  confirmResultFailed: (result: string) => result.includes("DECLINED")
    || result.startsWith("ERROR:")
    || /-\s*Status:\s*FAIL\b/i.test(result)
    || /\bStatus:\s*FAIL\b/i.test(result),
}));

vi.mock("../../src/agents/mcp/commit.js", () => ({
  runCommitAgent: mocks.runCommitAgent,
  runCommitAgentWithSharedConfirm: mocks.runCommitAgentWithSharedConfirm,
}));

vi.mock("../../src/agents/mcp/push.js", () => ({
  runPushAgent: mocks.runPushAgent,
}));

vi.mock("../../src/agents/mcp/transcript.js", () => ({
  runTranscriptAgent: mocks.runTranscriptAgent,
}));

vi.mock("../../src/agents/mcp/locate-scenario.js", () => ({
  runLocateScenarioMcp: mocks.runLocateScenarioMcp,
}));

vi.mock("../../src/rules/index.js", () => ({
  evaluateRules: mocks.evaluateRules,
}));

vi.mock("../../src/utils/session-store.js", () => ({
  getSessionState: mocks.getSessionState,
}));

vi.mock("../../src/utils/paths.js", () => ({
  getAgentFrameworkSessionDir: mocks.getAgentFrameworkSessionDir,
}));

vi.mock("../../src/agents/mcp/scenario-labeler.js", () => ({
  LABELER_HELP: "labeler help",
  handleScenarioLabeler: mocks.handleScenarioLabeler,
}));

vi.mock("../../src/agents/mcp/scenario-tester.js", () => ({
  TESTER_HELP: "tester help",
  handleScenarioTester: mocks.handleScenarioTester,
}));

vi.mock("../../src/utils/git-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/git-utils.js")>();
  return {
    ...actual,
    getRepoInfo: mocks.getRepoInfo,
    getRepoInfoCancellable: mocks.getRepoInfoCancellable,
    sortReposWithChangesSubmodulesFirst: mocks.sortReposWithChangesSubmodulesFirst,
  };
});

vi.mock("../../src/utils/elicitation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/elicitation.js")>();
  return {
    ...actual,
    elicitRepoSelection: mocks.elicitRepoSelection,
    elicitRepoScope: mocks.elicitRepoScope,
    elicitPreferences: mocks.elicitPreferences,
    sortReposSubmodulesFirst: mocks.sortReposSubmodulesFirst,
    parseUncertainties: mocks.parseUncertainties,
    elicitUncertaintyClarification: mocks.elicitUncertaintyClarification,
  };
});

vi.mock("../../src/telemetry/index.js", () => ({
  initializeTelemetry: mocks.initializeTelemetry,
}));

const repoInfo = {
  mainRepo: "/repo/main",
  mainRepoName: "main",
  mainRepoHasChanges: true,
  submodules: [{ path: "sub", absolutePath: "/repo/main/sub", hasChanges: true }],
  reposWithChanges: [
    { path: "/repo/main", name: "main" },
    { path: "/repo/main/sub", name: "sub" },
  ],
};

async function callTool(name: "confirm" | "commit", args: Record<string, unknown>) {
  const tool = mocks.tools.get(name);
  expect(tool).toBeDefined();
  return await tool!.handler(args, { signal: undefined });
}

describe("MCP server repo-scope routing", () => {
  beforeAll(async () => {
    await import("../../src/mcp/server.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRepoInfoCancellable.mockResolvedValue(repoInfo);
    mocks.sortReposWithChangesSubmodulesFirst.mockReturnValue([
      { path: "/repo/main/sub", name: "sub" },
      { path: "/repo/main", name: "main" },
    ]);
    mocks.sortReposSubmodulesFirst.mockImplementation((repos) => repos);
    mocks.elicitRepoSelection.mockResolvedValue([{ path: "/repo/main/sub", name: "sub" }]);
    mocks.elicitPreferences.mockResolvedValue({ modelTier: "haiku", focus: undefined });
    mocks.parseUncertainties.mockReturnValue([]);
    mocks.runConfirmAgent.mockResolvedValue("## Verdict\nCONFIRMED: ok");
    mocks.runCommitAgentWithSharedConfirm.mockResolvedValue("## Verdict\nCONFIRMED: ok\n\nSIZE: SMALL\ncommit: scoped\nHASH: abc123");
    mocks.runCommitAgent.mockResolvedValue("## Verdict\nCONFIRMED: ok\n\nSIZE: SMALL\ncommit: scoped\nHASH: def456");
  });

  it("routes confirm skip_elicitation through all scope without individual forms", async () => {
    const result = await callTool("confirm", {
      working_dir: "/repo/main",
      skip_elicitation: true,
    });

    expect(result.content[0].text).toContain("CONFIRMED");
    expect(mocks.elicitRepoScope).not.toHaveBeenCalled();
    expect(mocks.elicitRepoSelection).not.toHaveBeenCalled();
    expect(mocks.elicitPreferences).not.toHaveBeenCalled();
    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      "/repo/main",
      "opus",
      undefined,
      undefined,
      expect.objectContaining({ repoScope: { mode: "all", repoInfo } }),
    );
  });

  it("routes confirm individual scope through repo selection and per-repo preferences", async () => {
    mocks.elicitRepoScope.mockResolvedValue("individual");

    await callTool("confirm", {
      working_dir: "/repo/main",
      skip_elicitation: false,
    });

    expect(mocks.elicitRepoScope).toHaveBeenCalledWith(
      mocks.mcpServerInstance.server,
      "confirm",
      repoInfo,
      expect.any(Object),
    );
    expect(mocks.elicitRepoSelection).toHaveBeenCalled();
    expect(mocks.elicitPreferences).toHaveBeenCalledWith(
      mocks.mcpServerInstance.server,
      "sub",
      expect.any(Object),
    );
    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      "/repo/main/sub",
      "haiku",
      undefined,
      undefined,
      expect.objectContaining({ repoScope: { mode: "single", repoInfo } }),
    );
  });

  it("routes commit all scope through one confirm and shared-confirm commits", async () => {
    const result = await callTool("commit", {
      working_dir: "/repo/main",
      skip_elicitation: true,
    });

    expect(result.content[0].text).toContain("HASH: abc123");
    expect(mocks.runConfirmAgent).toHaveBeenCalledTimes(1);
    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      "/repo/main",
      "opus",
      undefined,
      undefined,
      expect.objectContaining({ repoScope: { mode: "all", repoInfo } }),
    );
    expect(mocks.runCommitAgent).not.toHaveBeenCalled();
    expect(mocks.runCommitAgentWithSharedConfirm).toHaveBeenCalledTimes(2);
    expect(mocks.runCommitAgentWithSharedConfirm.mock.calls[0][2]).toContain("SHARED ALL-REPOSITORIES CONFIRM CONTEXT");
  });

  it("retries all-scope commit confirm when declined with uncertainty clarification", async () => {
    mocks.elicitRepoScope.mockResolvedValue("all");
    mocks.runConfirmAgent
      .mockResolvedValueOnce("## Verdict\nDECLINED: docs ambiguous\nUNCERTAIN: docs - Which docs apply?")
      .mockResolvedValueOnce("## Verdict\nCONFIRMED: clarified");
    mocks.parseUncertainties.mockReturnValue([{ category: "docs", description: "Which docs apply?" }]);
    mocks.elicitUncertaintyClarification.mockResolvedValue("User clarifications:\ndocs: no docs needed");

    const result = await callTool("commit", {
      working_dir: "/repo/main",
      skip_elicitation: false,
    });

    expect(result.content[0].text).toContain("HASH: abc123");
    expect(mocks.elicitUncertaintyClarification).toHaveBeenCalledWith(
      mocks.mcpServerInstance.server,
      [{ category: "docs", description: "Which docs apply?" }],
      expect.any(Object),
    );
    expect(mocks.runConfirmAgent).toHaveBeenCalledTimes(2);
    expect(mocks.runConfirmAgent.mock.calls[1][2]).toBe("User clarifications:\ndocs: no docs needed");
    expect(mocks.runCommitAgentWithSharedConfirm).toHaveBeenCalled();
  });
});
