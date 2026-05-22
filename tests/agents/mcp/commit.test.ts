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
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

import { runCommitAgent } from "../../../src/agents/mcp/commit.js";

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
      runCommitAgent(repo, "haiku", undefined, undefined, undefined, { signal: activeController.signal }),
    ).rejects.toMatchObject({ name: "OperationCancelledError" });

    expect(git(repo, ["rev-parse", "HEAD"]).trim()).toBe(before);
    expect(git(repo, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("returns declined confirm output verbatim with all listed check errors", async () => {
    fs.writeFileSync(path.join(repo, "file.txt"), "content\n");
    const declined = `## Results
- Files: SKIP
- Code Quality: SKIP
- Security: SKIP
- Documentation: SKIP
- Tests: SKIP

## Check Failure
- Errors: 2

## Check Errors
src/foo.ts:12: Type 'string' is not assignable to type 'number'.
src/bar.ts:8: 'unusedValue' is declared but its value is never read.

## Verdict
DECLINED: check failed with 2 error(s); see Check Errors above.`;
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

    await runCommitAgent(repo, "haiku", "focus", "/tmp/transcript.jsonl", "plan.md");

    expect(mocks.runConfirmAgent).toHaveBeenCalledWith(
      repo,
      "haiku",
      "focus",
      "/tmp/transcript.jsonl",
      "plan.md",
      expect.any(Object),
    );
  });

  it("exposes optional_planfile on the commit MCP schema", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('server.registerTool(\n  "commit"');
    const end = serverSource.indexOf('server.registerTool(\n  "push"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const commitBlock = serverSource.slice(start, end);

    expect(commitBlock).toContain("optional_planfile");
  });
});
