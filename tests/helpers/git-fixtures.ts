import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export function runGitFixture(repo: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function prepareMovedRecreatedFile(
  repo: string,
  options: {
    oldPath?: string;
    newPath?: string;
    oldContent?: string;
    newContent?: string;
    commitMessage?: string;
    staging?: "none" | "source-deletion" | "move";
  } = {},
): void {
  const oldPath = options.oldPath ?? "src/helper.ts";
  const newPath = options.newPath ?? "lib/helper.ts";
  const oldContent = options.oldContent ?? "export const value = 1;\n";
  const newContent = options.newContent ?? oldContent;
  fs.mkdirSync(path.dirname(path.join(repo, oldPath)), { recursive: true });
  fs.mkdirSync(path.dirname(path.join(repo, newPath)), { recursive: true });
  fs.writeFileSync(path.join(repo, oldPath), oldContent);
  runGitFixture(repo, ["add", oldPath]);
  runGitFixture(repo, ["commit", "-m", options.commitMessage ?? "add helper"]);
  fs.rmSync(path.join(repo, oldPath));
  if (options.staging === "source-deletion") {
    runGitFixture(repo, ["add", "-u", "--", oldPath]);
  }
  fs.writeFileSync(path.join(repo, newPath), newContent);
  if (options.staging === "move") {
    runGitFixture(repo, ["add", "-A", "--", oldPath, newPath]);
  }
}
