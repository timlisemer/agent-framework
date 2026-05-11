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

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runConfirmAgent.mockResolvedValue("## Verdict\nCONFIRMED: ok");
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
});
