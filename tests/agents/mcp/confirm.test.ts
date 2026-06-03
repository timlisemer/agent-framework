import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  runCheckAgent: vi.fn(),
  runAgent: vi.fn(),
  getUncommittedChangesCancellable: vi.fn(),
  getAllReposGitContextCancellable: vi.fn(),
  getSingleRepoGitContextWithSiblingOverviewCancellable: vi.fn(),
  formatGitContextForRepos: vi.fn(),
}));

vi.mock("../../../src/agents/mcp/check.js", () => ({
  runCheckAgent: mocks.runCheckAgent,
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("../../../src/utils/git-utils.js", () => ({
  getUncommittedChangesCancellable: mocks.getUncommittedChangesCancellable,
  getAllReposGitContextCancellable: mocks.getAllReposGitContextCancellable,
  getSingleRepoGitContextWithSiblingOverviewCancellable: mocks.getSingleRepoGitContextWithSiblingOverviewCancellable,
  formatGitContextForRepos: mocks.formatGitContextForRepos,
}));

import { formatCheckFailure, runConfirmAgent } from "../../../src/agents/mcp/confirm.js";
import { getAgentFrameworkSessionDir, sessionCurrentPlanFile } from "../../../src/utils/paths.js";

describe("formatCheckFailure", () => {
  it("returns check output verbatim when confirm declines before investigation", () => {
    const checkResult = `## Results
- Errors: 2
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:12: Type 'string' is not assignable to type 'number'.
src/bar.ts:8: 'unusedValue' is declared but its value is never read.

## Warnings
(none)`;

    const result = formatCheckFailure(checkResult, 2);

    expect(result).toBe(checkResult);
    expect(result).not.toContain("- Deduplication: SKIP");
    expect(result).not.toContain("## Check Errors");
    expect(result).not.toContain("DECLINED: check failed");
  });

  it("returns malformed check output unchanged", () => {
    const checkResult = "tool failed before producing structured sections";

    const result = formatCheckFailure(checkResult, 1);

    expect(result).toBe(checkResult);
  });
});

describe("runConfirmAgent planfile context", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-agent-"));
    mocks.runCheckAgent.mockResolvedValue(`## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)`);
    mocks.getUncommittedChangesCancellable.mockResolvedValue({
      status: " M src/example.ts",
      diff: "diff --git a/src/example.ts b/src/example.ts",
    });
    mocks.getAllReposGitContextCancellable.mockResolvedValue({
      repos: [
        {
          name: "repo",
          path: tempDir,
          changes: {
            status: " M src/example.ts",
            diff: "diff --git a/src/example.ts b/src/example.ts",
            diffStat: "src/example.ts | 1 +",
            untrackedDiff: "",
          },
        },
      ],
      context: "=== REPOSITORY: repo ===\ncombined context",
    });
    mocks.getSingleRepoGitContextWithSiblingOverviewCancellable.mockResolvedValue({
      current: {
        name: "repo",
        path: tempDir,
        changes: {
          status: " M src/example.ts",
          diff: "diff --git a/src/example.ts b/src/example.ts",
          diffStat: "src/example.ts | 1 +",
          untrackedDiff: "",
        },
      },
      siblingOverview: "=== SIBLING REPOSITORY OVERVIEW ===\nsibling stat",
    });
    mocks.formatGitContextForRepos.mockReturnValue("CURRENT FULL CONTEXT");
    mocks.runAgent.mockResolvedValue({
      output: "## Verdict\nCONFIRMED: ok",
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("injects explicit optional_planfile content into confirm context", async () => {
    const planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, "Plan Name: test-plan\n\nImplement x.\n");

    const result = await runConfirmAgent(tempDir, "haiku", undefined, planPath);

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalled();
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE PATH:");
    expect(context).toContain(planPath);
    expect(context).toContain("PLANFILE CONTENT:");
    expect(context).toContain("Implement x.");
  });

  it("adds the Deduplication category to the confirm agent prompt and fallback output", async () => {
    await runConfirmAgent(tempDir, "haiku");

    const config = mocks.runAgent.mock.calls[0][0];
    expect(config.systemPrompt).toContain("## REQUIRED CATEGORY UPDATE: Deduplication");
    expect(config.systemPrompt).toContain("- Deduplication: PASS or FAIL");
    expect(config.systemPrompt).toContain("DEDUPLICATION USER REQUIREMENT");
    expect(config.systemPrompt).not.toContain("This quote requirement applies ONLY to deduplication/generic-code wishes");
    expect(config.formatValidation.fallbackOutput).toContain("- Deduplication: UNKNOWN");
  });

  it("injects the deduplication user requirement only when regex-detected in context", async () => {
    const transcriptPath = path.join(tempDir, "dedup-transcript.jsonl");
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "please remove the duplicate code and reuse existing code",
        },
      }) + "\n",
    );
    getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });

    await runConfirmAgent(tempDir, "haiku", "Focus: generated review-depth text");

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("=== DEDUPLICATION USER REQUIREMENT ===");
    expect(context).toContain("Exact user wording: \"please remove the duplicate code and reuse existing code\"");

    mocks.runAgent.mockClear();
    fs.unlinkSync(transcriptPath);
    await runConfirmAgent(tempDir, "haiku", "please remove the duplicate code and reuse existing code");

    const nextContext = mocks.runAgent.mock.calls[0][1].context as string;
    expect(nextContext).toContain("=== DEDUPLICATION USER REQUIREMENT ===");
  });

  it("does not treat generated review-depth guidance as a user deduplication requirement", async () => {
    await runConfirmAgent(
      tempDir,
      "haiku",
      "Focus: [generated confirm review-depth guidance] In depth confirm review: check deduplication/generic-code concerns.",
    );

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).not.toContain("=== DEDUPLICATION USER REQUIREMENT ===");
  });

  it("does not scan assistant-authored planfile text for deduplication requirements", async () => {
    const planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, "Plan Name: x\n\nCreate a generic helper for repeated logic.\n");

    await runConfirmAgent(tempDir, "haiku", undefined, planPath);

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).not.toContain("=== DEDUPLICATION USER REQUIREMENT ===");
  });

  it("returns an error before LLM when explicit optional_planfile is unreadable after check passes", async () => {
    const missingPath = path.join(tempDir, "missing.md");

    const result = await runConfirmAgent(tempDir, "haiku", undefined, missingPath);

    expect(result).toContain("ERROR: optional_planfile was provided but could not be read");
    expect(result).toContain(missingPath);
    expect(mocks.runCheckAgent).toHaveBeenCalled();
    expect(mocks.getUncommittedChangesCancellable).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("returns an error before LLM when explicit optional_planfile is blank after check passes", async () => {
    const result = await runConfirmAgent(tempDir, "haiku", undefined, "  ");

    expect(result).toBe("ERROR: optional_planfile was provided but the planfile path is empty.");
    expect(mocks.runCheckAgent).toHaveBeenCalled();
    expect(mocks.getUncommittedChangesCancellable).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("returns check failure before optional_planfile deterministic errors", async () => {
    const missingPath = path.join(tempDir, "missing.md");
    mocks.runCheckAgent.mockResolvedValue(`## Results
- Errors: 1
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:1: Type error.

## Warnings
(none)`);

    const result = await runConfirmAgent(tempDir, "haiku", undefined, missingPath);

    expect(result).toBe(`## Results
- Errors: 1
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:1: Type error.

## Warnings
(none)`);
    expect(result).not.toContain("optional_planfile");
    expect(mocks.getUncommittedChangesCancellable).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("continues without plan input when no session planfile is available", async () => {
    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalledWith(tempDir, undefined, expect.any(Object));
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE CONTEXT: No planfile was provided through optional_planfile");
    expect(context).toContain("Continue evaluating the code changes without plan input.");
  });

  it("runs combined check and uses all-repos git context for all scope", async () => {
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "repo",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [{ path: tempDir, name: "repo" }],
    };

    await runConfirmAgent(tempDir, "haiku", undefined, undefined, {
      repoScope: { mode: "all", repoInfo },
    });

    expect(mocks.runCheckAgent).toHaveBeenCalledWith(
      tempDir,
      undefined,
      expect.objectContaining({ repoScope: { mode: "all", repoInfo } }),
    );
    expect(mocks.getAllReposGitContextCancellable).toHaveBeenCalledWith(repoInfo, expect.any(Object));
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("combined context");
  });

  it("adds sibling overview context in individual multi-repo mode", async () => {
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "repo",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [
        { path: tempDir, name: "repo" },
        { path: path.join(tempDir, "sub"), name: "sub" },
      ],
    };

    await runConfirmAgent(tempDir, "haiku", undefined, undefined, {
      repoScope: { mode: "single", repoInfo },
    });

    expect(mocks.getSingleRepoGitContextWithSiblingOverviewCancellable).toHaveBeenCalledWith(
      tempDir,
      repoInfo,
      expect.any(Object),
    );
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("CURRENT FULL CONTEXT");
    expect(context).toContain("SIBLING REPOSITORY OVERVIEW");
  });

  it("continues without plan input when stored session planfile is empty", async () => {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });
    const planPath = path.join(tempDir, "empty-plan.md");
    fs.writeFileSync(planPath, "  \n");
    fs.writeFileSync(
      sessionCurrentPlanFile(sessionDir),
      JSON.stringify({ kind: "file", path: planPath, planName: "empty-plan" }) + "\n",
    );

    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE CONTEXT: No planfile was provided through optional_planfile");

    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("uses the current session when available", async () => {
    const transcriptPath = path.join(tempDir, "sidecar-transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });
    const planPath = path.join(tempDir, "session-plan.md");
    fs.writeFileSync(planPath, "Plan Name: session-plan\n\nUse session plan.\n");
    fs.writeFileSync(
      sessionCurrentPlanFile(sessionDir),
      JSON.stringify({ kind: "file", path: planPath, planName: "session-plan" }) + "\n",
    );

    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalledWith(tempDir, undefined, expect.any(Object));
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE PATH:");
    expect(context).toContain(planPath);
    expect(context).toContain("Use session plan.");

    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("exposes optional_planfile on the confirm MCP schema", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('registerTimedTool(\n  "confirm"');
    const end = serverSource.indexOf('registerTimedTool(\n  "commit"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const confirmBlock = serverSource.slice(start, end);

    expect(confirmBlock).toContain("optional_planfile");
    expect(confirmBlock).not.toContain("transcript_path");
    expect(confirmBlock).not.toContain("repo_scope:");
    expect(confirmBlock).not.toContain("model_tier is required when skip_elicitation is true");
    expect(confirmBlock).toContain('elicitRepoScope(server.server, "confirm"');
    expect(confirmBlock).toContain('repoScope: { mode: "all", repoInfo }');
  });
});
