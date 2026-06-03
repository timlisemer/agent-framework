import { execFileSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  formatGitContextForRepos,
  formatSiblingRepoOverview,
  getSingleRepoGitContextWithSiblingOverviewCancellable,
  getGitStatusCancellable,
  getUncommittedChangesCancellable,
  sortReposWithChangesSubmodulesFirst,
} from "../../src/utils/git-utils.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("bounded git utilities", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-git-utils-"));
    git(repoDir, ["init"]);
    git(repoDir, ["config", "user.email", "test@example.com"]);
    git(repoDir, ["config", "user.name", "Test User"]);
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\n");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "initial"]);
  });

  afterEach(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it("reads status without requiring full diff collection", async () => {
    fs.writeFileSync(path.join(repoDir, "large-untracked.txt"), "x".repeat(256 * 1024));

    const status = await getGitStatusCancellable(repoDir);

    expect(status).toContain("?? large-untracked.txt");
    expect(status).not.toContain("x".repeat(1000));
  });

  it("bounds untracked file diff content", async () => {
    fs.writeFileSync(path.join(repoDir, "large-untracked.txt"), "x".repeat(8 * 1024 * 1024));

    const changes = await getUncommittedChangesCancellable(repoDir);

    expect(changes.status).toContain("?? large-untracked.txt");
    expect(Buffer.byteLength(changes.untrackedDiff, "utf-8")).toBeLessThan(3 * 1024 * 1024);
  });
});

describe("multi-repo git context helpers", () => {
  it("sorts dirty submodules before the main repository", () => {
    const repos = sortReposWithChangesSubmodulesFirst({
      mainRepo: "/repo/main",
      mainRepoName: "main",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [
        { path: "/repo/main", name: "main" },
        { path: "/repo/main/sub", name: "sub" },
      ],
    });

    expect(repos.map((repo) => repo.name)).toEqual(["sub", "main"]);
  });

  it("formats full context for all repos and overview-only context for siblings", () => {
    const contexts = [
      {
        path: "/repo/main/sub",
        name: "sub",
        changes: {
          status: " M sub.ts",
          diff: "diff --git a/sub.ts b/sub.ts",
          diffStat: "sub.ts | 1 +",
          untrackedDiff: "",
        },
      },
    ];

    expect(formatGitContextForRepos(contexts)).toContain("GIT DIFF (all uncommitted changes):\ndiff --git");
    const overview = formatSiblingRepoOverview(contexts);
    expect(overview).toContain("GIT DIFF STAT:");
    expect(overview).toContain("sub.ts | 1 +");
    expect(overview).not.toContain("diff --git");
  });

  it("collects only status and diff stat for sibling overview context", async () => {
    const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-git-utils-main-"));
    try {
      git(mainDir, ["init"]);
      git(mainDir, ["config", "user.email", "test@example.com"]);
      git(mainDir, ["config", "user.name", "Test User"]);
      fs.writeFileSync(path.join(mainDir, "tracked.txt"), "base\n");
      git(mainDir, ["add", "tracked.txt"]);
      git(mainDir, ["commit", "-m", "initial"]);
      const siblingDir = path.join(mainDir, "sibling");
      fs.mkdirSync(siblingDir);
      git(siblingDir, ["init"]);
      git(siblingDir, ["config", "user.email", "test@example.com"]);
      git(siblingDir, ["config", "user.name", "Test User"]);
      fs.writeFileSync(path.join(siblingDir, "sibling.txt"), "base\n");
      git(siblingDir, ["add", "sibling.txt"]);
      git(siblingDir, ["commit", "-m", "initial"]);
      fs.writeFileSync(path.join(mainDir, "tracked.txt"), "base\ncurrent change\n");
      fs.writeFileSync(path.join(siblingDir, "sibling.txt"), "base\nsibling full diff should stay out\n");

      const result = await getSingleRepoGitContextWithSiblingOverviewCancellable(
        mainDir,
        {
          mainRepo: mainDir,
          mainRepoName: path.basename(mainDir),
          mainRepoHasChanges: true,
          submodules: [{ path: "sibling", absolutePath: siblingDir, hasChanges: true }],
          reposWithChanges: [
            { path: mainDir, name: "main" },
            { path: siblingDir, name: "sibling" },
          ],
        },
      );

      expect(result.current.changes.diff).toContain("current change");
      expect(result.siblingOverview).toContain("GIT DIFF STAT:");
      expect(result.siblingOverview).toContain("sibling.txt");
      expect(result.siblingOverview).not.toContain("sibling full diff should stay out");
      expect(result.siblingOverview).not.toContain("diff --git");
    } finally {
      fs.rmSync(mainDir, { recursive: true, force: true });
    }
  });
});
