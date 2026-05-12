import { execFileSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  getGitStatusCancellable,
  getUncommittedChangesCancellable,
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
