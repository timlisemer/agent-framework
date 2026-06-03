import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";

const mocks = vi.hoisted(() => ({
  runConfirmAgent: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("../../../src/agents/mcp/confirm.js", () => ({
  runConfirmAgent: mocks.runConfirmAgent,
  confirmResultFailed: (result: string) => result.includes("DECLINED")
    || result.startsWith("ERROR:")
    || /-\s*Status:\s*FAIL\b/i.test(result)
    || /\bStatus:\s*FAIL\b/i.test(result),
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

import { runCommitAgent, runCommitAgentWithSharedConfirm } from "../../../src/agents/mcp/commit.js";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "commit-agent-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
  git(repo, ["add", "base.txt"]);
  git(repo, ["commit", "-m", "initial commit"]);
  return repo;
}

describe("runCommitAgent", () => {
  let repo: string;
  let activeController: AbortController;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runConfirmAgent.mockResolvedValue("## Verdict\nCONFIRMED: ok");
    activeController = new AbortController();
    repo = makeRepo();
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it("commits backtick-wrapped proposed_plan text literally", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockResolvedValue({
      output: "SIZE: SMALL\nMESSAGE:\ncommit: include `<proposed_plan>` contract",
    });

    const result = await runCommitAgent(repo, "haiku");

    expect(result).toContain("HASH:");
    const message = git(repo, ["log", "-1", "--pretty=%B"]);
    expect(message).toContain("`<proposed_plan>`");
  });

  it("commits multiline shell-active text literally", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockResolvedValue({
      output: [
        "SIZE: LARGE",
        "MESSAGE:",
        "codex: add planning contract",
        "",
        "- Preserve literal `<proposed_plan>` text",
        "- Do not execute $(echo unsafe)",
      ].join("\n"),
    });

    const result = await runCommitAgent(repo, "haiku");

    expect(result).toContain("HASH:");
    const message = git(repo, ["log", "-1", "--pretty=%B"]);
    expect(message).toContain("`<proposed_plan>`");
    expect(message).toContain("$(echo unsafe)");
  });

  it("cancels before git add without creating a commit or staging files", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockImplementationOnce(async () => {
      const controller = activeController;
      controller.abort();
      return {
        output: "SIZE: SMALL\nMESSAGE:\ncommit: should not happen",
      };
    });
    const before = git(repo, ["rev-parse", "HEAD"]).trim();

    await expect(
      runCommitAgent(repo, "haiku", undefined, undefined, { signal: activeController.signal }),
    ).rejects.toMatchObject({ name: "OperationCancelledError" });

    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("returns raw failed check output verbatim without generating a commit message", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    const declined = `## Results
- Errors: 2
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:12: Type 'string' is not assignable to type 'number'.
src/bar.ts:8: 'unusedValue' is declared but its value is never read.

## Warnings
(none)`;
    mocks.runConfirmAgent.mockResolvedValue(declined);

    const result = await runCommitAgent(repo, "haiku");

    expect(result).toBe(declined);
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("forwards optional planfile to confirm", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockResolvedValue({
      output: "SIZE: SMALL\nMESSAGE:\ncommit: include planfile",
    });

    await runCommitAgent(repo, "haiku", "focus", "plan.md");

    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      repo,
      "haiku",
      "focus",
      "plan.md",
      expect.any(Object),
    );
  });

  it("commits with a shared confirm result without rerunning confirm", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockResolvedValue({
      output: "SIZE: SMALL\nMESSAGE:\ncommit: related repo change",
    });

    const result = await runCommitAgentWithSharedConfirm(
      repo,
      "## Verdict\nCONFIRMED: all repos ok",
      "SHARED ALL-REPOSITORIES CONFIRM CONTEXT:\nUse related messages.",
    );

    expect(result).toContain("HASH:");
    expect(mocks.runConfirmAgent).not.toHaveBeenCalled();
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("CONFIRMED: all repos ok");
    expect(context).toContain("Use related messages.");
  });

  it("passes individual multi-repo context through to confirm", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    mocks.runAgent.mockResolvedValue({
      output: "SIZE: SMALL\nMESSAGE:\ncommit: include sibling context",
    });
    const repoInfo = {
      mainRepo: repo,
      mainRepoName: "repo",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [{ path: repo, name: "repo" }],
    };

    await runCommitAgent(repo, "haiku", "focus", "plan.md", {
      repoScope: { mode: "single", repoInfo },
    });

    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      repo,
      "haiku",
      "focus",
      "plan.md",
      expect.objectContaining({ repoScope: { mode: "single", repoInfo } }),
    );
  });

  it("exposes optional_planfile on the commit MCP schema", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('registerTimedTool(\n  "commit"');
    const end = serverSource.indexOf('registerTimedTool(\n  "push"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const commitBlock = serverSource.slice(start, end);

    expect(commitBlock).toContain("optional_planfile");
    expect(commitBlock).not.toContain("transcript_path");
    expect(commitBlock).not.toContain("repo_scope:");
    expect(commitBlock).not.toContain("model_tier is required when skip_elicitation is true");
    expect(commitBlock).toContain('elicitRepoScope(server.server, "commit"');
    expect(commitBlock).toContain("runCommitAgentWithSharedConfirm");
  });
});
