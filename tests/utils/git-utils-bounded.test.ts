import { execFileSync } from "child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  formatGitContextForRepos,
  formatSiblingRepoOverview,
  findDeletedOrRenamedFileReferenceIssuesCancellable,
  findFilenameReferenceDiagnosticsCancellable,
  findNonexistentFileReferenceIssuesCancellable,
  detectMovedRecreatedFilesCancellable,
  getSingleRepoGitContextWithSiblingOverviewCancellable,
  getRepoGitContextsCancellable,
  getRepoFullScopeContextsCancellable,
  getGitStatusCancellable,
  getGitVisibleFileInventoryCancellable,
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

  it("detects an exact moved+recreated file as a move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "src", "helper.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "src/helper.ts"]);
    git(repoDir, ["commit", "-m", "add helper"]);
    fs.rmSync(path.join(repoDir, "src", "helper.ts"));
    fs.writeFileSync(path.join(repoDir, "lib", "helper.ts"), "export const value = 1;\n");

    const result = await detectMovedRecreatedFilesCancellable(repoDir);

    expect(result.moves).toEqual([
      {
        oldPath: "src/helper.ts",
        newPath: "lib/helper.ts",
        similarity: 100,
        mode: "moved",
      },
    ]);
    expect(result.skipped).toEqual([]);
  });

  it("normalizes moved+edited files virtually without mutating the real index", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(
      path.join(repoDir, "src", "helper.ts"),
      ["export function value() {", "  return 1;", "}", ""].join("\n"),
    );
    git(repoDir, ["add", "src/helper.ts"]);
    git(repoDir, ["commit", "-m", "add editable helper"]);
    fs.rmSync(path.join(repoDir, "src", "helper.ts"));
    fs.writeFileSync(
      path.join(repoDir, "lib", "helper.ts"),
      ["export function value() {", "  return 2;", "}", ""].join("\n"),
    );

    const changes = await getUncommittedChangesCancellable(repoDir, { normalizeMovedRecreated: true });

    expect(changes.normalizedMoves).toEqual([
      expect.objectContaining({
        oldPath: "src/helper.ts",
        newPath: "lib/helper.ts",
        mode: "moved-with-edits",
      }),
    ]);
    expect(changes.diff).toContain("rename from src/helper.ts");
    expect(changes.diff).toContain("rename to lib/helper.ts");
    expect(changes.diff).toContain("-  return 1;");
    expect(changes.diff).toContain("+  return 2;");
    expect(changes.diff).not.toContain("new file mode");
    expect(git(repoDir, ["diff", "--cached", "--name-only"]).trim()).toBe("");
  });

  it("normalizes moved+edited text files above the untracked diff synthesis limit", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    const largeLine = "x".repeat(3 * 1024 * 1024);
    fs.writeFileSync(path.join(repoDir, "src", "large.ts"), `${largeLine}\nexport const value = 1;\n`);
    git(repoDir, ["add", "src/large.ts"]);
    git(repoDir, ["commit", "-m", "add large"]);
    fs.rmSync(path.join(repoDir, "src", "large.ts"));
    fs.writeFileSync(path.join(repoDir, "lib", "large.ts"), `${largeLine}\nexport const value = 2;\n`);

    const result = await detectMovedRecreatedFilesCancellable(repoDir);

    expect(result.moves).toEqual([
      expect.objectContaining({
        oldPath: "src/large.ts",
        newPath: "lib/large.ts",
        mode: "moved-with-edits",
      }),
    ]);
  });

  it("preserves already-staged changes while building virtual normalized diffs", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\nstaged later\n");
    fs.writeFileSync(path.join(repoDir, "src", "helper.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "src/helper.ts"]);
    git(repoDir, ["commit", "-m", "add helper"]);
    git(repoDir, ["add", "tracked.txt"]);
    fs.rmSync(path.join(repoDir, "src", "helper.ts"));
    fs.writeFileSync(path.join(repoDir, "lib", "helper.ts"), "export const value = 1;\n");

    const changes = await getUncommittedChangesCancellable(repoDir, { normalizeMovedRecreated: true });

    expect(changes.diff).toContain("rename from src/helper.ts");
    expect(changes.diff).toContain("rename to lib/helper.ts");
    expect(changes.diff).toContain("+staged later");
    expect(git(repoDir, ["diff", "--cached", "--name-only"]).trim()).toBe("tracked.txt");
  });

  it("emits one normalized rename status for already-staged move pairs", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "src", "renamed.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "src/renamed.ts"]);
    git(repoDir, ["commit", "-m", "add renamed"]);
    fs.rmSync(path.join(repoDir, "src", "renamed.ts"));
    fs.writeFileSync(path.join(repoDir, "lib", "renamed.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "-A", "--", "src/renamed.ts", "lib/renamed.ts"]);

    const changes = await getUncommittedChangesCancellable(repoDir, {
      normalizeMovedRecreated: true,
      preparedNormalizedMoves: [
        { oldPath: "src/renamed.ts", newPath: "lib/renamed.ts", similarity: 100, mode: "moved" },
      ],
    });

    expect(changes.status.split("\n").filter((line) => line.includes("renamed.ts"))).toEqual([
      "R  src/renamed.ts -> lib/renamed.ts",
    ]);
  });

  it("skips ambiguous same-basename move candidates", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.mkdirSync(path.join(repoDir, "other"));
    fs.writeFileSync(path.join(repoDir, "src", "shared.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "src/shared.ts"]);
    git(repoDir, ["commit", "-m", "add shared"]);
    fs.rmSync(path.join(repoDir, "src", "shared.ts"));
    fs.writeFileSync(path.join(repoDir, "lib", "shared.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "other", "shared.ts"), "export const value = 1;\n");

    const result = await detectMovedRecreatedFilesCancellable(repoDir);

    expect(result.moves).toEqual([]);
    expect(result.skipped).toEqual([
      {
        oldPath: "src/shared.ts",
        newPaths: ["lib/shared.ts", "other/shared.ts"],
        reason: "ambiguous",
      },
    ]);
  });

  it("skips ambiguous many-old-to-one-new move candidates", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "src", "shared.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "lib", "shared.ts"), "export const value = 1;\n");
    git(repoDir, ["add", "src/shared.ts", "lib/shared.ts"]);
    git(repoDir, ["commit", "-m", "add duplicate basenames"]);
    fs.rmSync(path.join(repoDir, "src", "shared.ts"));
    fs.rmSync(path.join(repoDir, "lib", "shared.ts"));
    fs.writeFileSync(path.join(repoDir, "shared.ts"), "export const value = 1;\n");

    const result = await detectMovedRecreatedFilesCancellable(repoDir);

    expect(result.moves).toEqual([]);
    expect(result.skipped).toEqual([
      {
        oldPath: "lib/shared.ts",
        newPaths: ["shared.ts"],
        reason: "ambiguous",
      },
      {
        oldPath: "src/shared.ts",
        newPaths: ["shared.ts"],
        reason: "ambiguous",
      },
    ]);
  });

  it("leaves unrelated delete/create pairs unpaired", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "docs"));
    fs.writeFileSync(path.join(repoDir, "src", "note.txt"), "alpha\nbeta\ngamma\n");
    git(repoDir, ["add", "src/note.txt"]);
    git(repoDir, ["commit", "-m", "add note"]);
    fs.rmSync(path.join(repoDir, "src", "note.txt"));
    fs.writeFileSync(path.join(repoDir, "docs", "note.txt"), "unrelated\ncontent\nonly\n");

    const result = await detectMovedRecreatedFilesCancellable(repoDir);

    expect(result.moves).toEqual([]);
  });

  it("counts git-visible text files for fullconfirm inventory", async () => {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\nsecond\n");
    fs.writeFileSync(path.join(repoDir, "untracked.txt"), "one\ntwo\nthree\n");
    fs.writeFileSync(path.join(repoDir, "ignored.txt"), "ignored\n");
    fs.writeFileSync(path.join(repoDir, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const inventory = await getGitVisibleFileInventoryCancellable(repoDir);

    expect(inventory.files.map((file) => file.path)).toContain("tracked.txt");
    expect(inventory.files.map((file) => file.path)).toContain("untracked.txt");
    expect(inventory.files.map((file) => file.path)).not.toContain("ignored.txt");
    expect(inventory.files.map((file) => file.path)).not.toContain("binary.bin");
    expect(inventory.totalLines).toBeGreaterThanOrEqual(5);
    expect(inventory.skippedBinary).toBe(1);
  });

  it("omits untracked files from fullconfirm scope context", async () => {
    fs.writeFileSync(path.join(repoDir, "untracked-fullconfirm.txt"), "untracked\n");

    const result = await getRepoFullScopeContextsCancellable([
      { path: repoDir, name: "repo" },
    ]);

    expect(result.context).toContain("tracked.txt");
    expect(result.context).not.toContain("untracked-fullconfirm.txt");
  });

  it("reports references to a truly deleted filename", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "old-helper.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './old-helper.ts';\n");
    git(repoDir, ["add", "src/old-helper.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add helper"]);
    fs.rmSync(path.join(repoDir, "src", "old-helper.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/old-helper.ts");
    expect(issues[0].changeType).toBe("deleted");
    expect(issues[0].references).toEqual([
      { path: "src/index.ts", line: 1, text: "import './old-helper.ts';" },
    ]);
  });

  it("does not report references to existing different paths with similar basenames", async () => {
    fs.mkdirSync(path.join(repoDir, "src-tauri", "icons"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "libs", "iocto-website-backend-lib"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "iocto-website", "src"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "iocto-website", "static"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "Cargo.toml"), "[workspace]\n");
    fs.writeFileSync(path.join(repoDir, "src-tauri", "Cargo.toml"), "[package]\nname = \"old-tauri\"\n");
    fs.writeFileSync(
      path.join(repoDir, "libs", "iocto-website-backend-lib", "Cargo.toml"),
      "[package]\nname = \"iocto-backend\"\n",
    );
    fs.writeFileSync(path.join(repoDir, "src-tauri", "icons", "icon.ico"), "old icon\n");
    fs.writeFileSync(path.join(repoDir, "iocto-website", "static", "favicon.ico"), "website icon\n");
    fs.writeFileSync(
      path.join(repoDir, "justfile"),
      "update:\n  cargo update --manifest-path libs/iocto-website-backend-lib/Cargo.toml\n",
    );
    fs.writeFileSync(
      path.join(repoDir, "Dockerfile"),
      "FROM rust:latest\nRUN cargo build --manifest-path Cargo.toml -p iocto-backend --release\n",
    );
    fs.writeFileSync(
      path.join(repoDir, "iocto-website", "src", "app.html"),
      "<link rel=\"icon\" href=\"%sveltekit.assets%/favicon.ico\" />\n",
    );
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "add tauri and website files"]);
    fs.rmSync(path.join(repoDir, "src-tauri", "Cargo.toml"));
    fs.rmSync(path.join(repoDir, "src-tauri", "icons", "icon.ico"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("reports root-anchored references to deleted paths", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "deleted.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "index.html"), "<script src=\"/src/deleted.ts\"></script>\n");
    git(repoDir, ["add", "src/deleted.ts", "index.html"]);
    git(repoDir, ["commit", "-m", "add root-anchored reference"]);
    fs.rmSync(path.join(repoDir, "src", "deleted.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/deleted.ts");
    expect(issues[0].references).toEqual([
      { path: "index.html", line: 1, text: "<script src=\"/src/deleted.ts\"></script>" },
    ]);
  });

  it("reports bare same-directory references to deleted paths", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "deleted.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.html"), "<script src=\"deleted.ts\"></script>\n");
    git(repoDir, ["add", "src/deleted.ts", "src/index.html"]);
    git(repoDir, ["commit", "-m", "add bare same-directory reference"]);
    fs.rmSync(path.join(repoDir, "src", "deleted.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/deleted.ts");
    expect(issues[0].references).toEqual([
      { path: "src/index.html", line: 1, text: "<script src=\"deleted.ts\"></script>" },
    ]);
  });

  it("does not report references from deleted files", async () => {
    fs.mkdirSync(path.join(repoDir, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, ".github", "workflows", "manual-build.yml"),
      "name: manual-build\n",
    );
    fs.writeFileSync(
      path.join(repoDir, ".github", "workflows", "cleanup.yml"),
      "uses: ./.github/workflows/manual-build.yml\n",
    );
    git(repoDir, ["add", ".github/workflows/manual-build.yml", ".github/workflows/cleanup.yml"]);
    git(repoDir, ["commit", "-m", "add workflows"]);
    git(repoDir, ["rm", "--cached", ".github/workflows/manual-build.yml", ".github/workflows/cleanup.yml"]);

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not report unrelated generic barrel filename mentions", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Create an index.ts barrel when adding a package.\n");
    git(repoDir, ["add", "src/index.ts", "README.md"]);
    git(repoDir, ["commit", "-m", "add barrel"]);
    fs.rmSync(path.join(repoDir, "src", "index.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("reports deleted generic barrel files when the old path remains referenced", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Import from src/index.ts while migrating.\n");
    git(repoDir, ["add", "src/index.ts", "README.md"]);
    git(repoDir, ["commit", "-m", "add barrel reference"]);
    fs.rmSync(path.join(repoDir, "src", "index.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/index.ts");
    expect(issues[0].references).toEqual([
      { path: "README.md", line: 1, text: "Import from src/index.ts while migrating." },
    ]);
  });

  it("reports stale filename references after a same-basename move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "src", "same-name.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './same-name.ts';\n");
    git(repoDir, ["add", "src/same-name.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add same-name"]);
    fs.renameSync(path.join(repoDir, "src", "same-name.ts"), path.join(repoDir, "lib", "same-name.ts"));
    git(repoDir, ["add", "-A"]);

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/same-name.ts");
    expect(issues[0].changeType).toBe("renamed");
    expect(issues[0].references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("reports old-path references after git mv", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, "src", "git-moved.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Import from src/git-moved.ts after move.\n");
    git(repoDir, ["add", "src/git-moved.ts", "README.md"]);
    git(repoDir, ["commit", "-m", "add git moved file"]);
    git(repoDir, ["mv", "src/git-moved.ts", "lib/git-moved.ts"]);

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/git-moved.ts");
    expect(issues[0].changeType).toBe("renamed");
    expect(issues[0].references).toEqual([
      { path: "README.md", line: 1, text: "Import from src/git-moved.ts after move." },
    ]);
  });

  it("warns when a file mentions a path-like file that does not exist", async () => {
    fs.mkdirSync(path.join(repoDir, "docs"));
    fs.writeFileSync(path.join(repoDir, "README.md"), "See docs/missing.md.\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add missing docs reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/missing.md",
        references: [
          { path: "README.md", line: 1, text: "See docs/missing.md." },
        ],
      },
    ]);
  });

  it("does not warn for external protocol URLs with path-like suffixes", async () => {
    fs.writeFileSync(path.join(repoDir, "README.md"), "See https://example.com/docs/missing.md.\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add external url reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not warn when prose and config literals resolve from the repo root", async () => {
    fs.mkdirSync(path.join(repoDir, ".github", "actions", "setup"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "docs", "nested"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "libs", "foo"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "libs", "foo", "package.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "justfile"), "check:\n  true\n");
    fs.writeFileSync(
      path.join(repoDir, ".github", "actions", "setup", "action.yml"),
      "runs:\n  steps:\n    - run: cat libs/foo/package.json\n",
    );
    fs.writeFileSync(
      path.join(repoDir, "docs", "nested", "README.md"),
      "Use the justfile from the project root.\n",
    );
    fs.writeFileSync(path.join(repoDir, "README.md"), "Run the Justfile command.\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "add repo-root reference examples"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not warn for intentional local env file references", async () => {
    fs.writeFileSync(path.join(repoDir, ".gitignore"), ".env\n.env.local\n");
    fs.writeFileSync(path.join(repoDir, ".env.example"), "EXAMPLE=true\n");
    fs.writeFileSync(path.join(repoDir, "Cargo.toml"), "env_file = \".env\"\n");
    fs.writeFileSync(
      path.join(repoDir, "README.md"),
      ["Copy .env.example to .env.", "Use .env.local for local overrides.", ""].join("\n"),
    );
    fs.writeFileSync(path.join(repoDir, "docker-compose.yml"), "services:\n  app:\n    env_file: .env\n");
    git(repoDir, ["add", "."]);
    git(repoDir, ["commit", "-m", "add env reference examples"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("warns for unignored env typos even when a generic env template exists", async () => {
    fs.writeFileSync(path.join(repoDir, ".env.example"), "EXAMPLE=true\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Use .env.prodution for production settings.\n");
    git(repoDir, ["add", ".env.example", "README.md"]);
    git(repoDir, ["commit", "-m", "add env typo reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: ".env.prodution",
        references: [
          { path: "README.md", line: 1, text: "Use .env.prodution for production settings." },
        ],
      },
    ]);
  });

  it("does not warn for non-env copy instruction targets when the source exists", async () => {
    fs.mkdirSync(path.join(repoDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "templates", "config.json"), "{}\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Copy templates/config.json to config/local.json.\n");
    git(repoDir, ["add", "templates/config.json", "README.md"]);
    git(repoDir, ["commit", "-m", "add copy target instruction"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("still warns for unrelated missing references after copy instruction targets", async () => {
    fs.mkdirSync(path.join(repoDir, "templates"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "templates", "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(repoDir, "README.md"),
      "Copy templates/config.json to config/local.json and see docs/missing.md.\n",
    );
    git(repoDir, ["add", "templates/config.json", "README.md"]);
    git(repoDir, ["commit", "-m", "add copy target with later missing reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/missing.md",
        references: [
          {
            path: "README.md",
            line: 1,
            text: "Copy templates/config.json to config/local.json and see docs/missing.md.",
          },
        ],
      },
    ]);
  });

  it("does not warn for creation instructions and placeholder target paths", async () => {
    fs.writeFileSync(
      path.join(repoDir, "README.md"),
      "Create src/api/YourModelService.ts and src/stores/yourModelHelper.ts for your model.\n",
    );
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add placeholder creation instructions"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("warns for markdown links with create in the link text", async () => {
    fs.writeFileSync(path.join(repoDir, "README.md"), "See [create docs](docs/missing.md).\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add create link text"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/missing.md",
        references: [
          { path: "README.md", line: 1, text: "See [create docs](docs/missing.md)." },
        ],
      },
    ]);
  });

  it("warns for negated create prose", async () => {
    fs.writeFileSync(path.join(repoDir, "README.md"), "Do not create docs/missing.md.\n");
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add negated create reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/missing.md",
        references: [
          { path: "README.md", line: 1, text: "Do not create docs/missing.md." },
        ],
      },
    ]);
  });

  it("warns for missing markdown link targets relative to the source file", async () => {
    fs.mkdirSync(path.join(repoDir, "docs"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, "guide"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "guide", "api.md"), "Root guide exists.\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "See [architecture](MISSING.md).\n");
    fs.writeFileSync(path.join(repoDir, "docs", "README.md"), "See [API](guide/api.md).\n");
    git(repoDir, ["add", "README.md", "docs/README.md", "guide/api.md"]);
    git(repoDir, ["commit", "-m", "add missing markdown links"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/guide/api.md",
        references: [
          { path: "docs/README.md", line: 1, text: "See [API](guide/api.md)." },
        ],
      },
      {
        referencedPath: "MISSING.md",
        references: [
          { path: "README.md", line: 1, text: "See [architecture](MISSING.md)." },
        ],
      },
    ]);
  });

  it("still warns when nested prose references the wrong repo-root path", async () => {
    fs.mkdirSync(path.join(repoDir, "iocto-backend", "src", "web"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "iocto-backend", "src", "web", "models.rs"), "pub struct Model;\n");
    fs.writeFileSync(path.join(repoDir, "iocto-backend", "README.md"), "See web/models.rs.\n");
    git(repoDir, ["add", "iocto-backend/src/web/models.rs", "iocto-backend/README.md"]);
    git(repoDir, ["commit", "-m", "add nested wrong-path reference"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "iocto-backend/web/models.rs",
        references: [
          { path: "iocto-backend/README.md", line: 1, text: "See web/models.rs." },
        ],
      },
    ]);
  });

  it("warns from extensionless config files and for extensionless config targets", async () => {
    fs.writeFileSync(path.join(repoDir, "Makefile"), ["check:", "\tcat docs/missing.md", ""].join("\n"));
    fs.writeFileSync(path.join(repoDir, "README.md"), "See [container](Dockerfile).\n");
    git(repoDir, ["add", "Makefile", "README.md"]);
    git(repoDir, ["commit", "-m", "add extensionless reference examples"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    const referencesByPath = new Map(issues.map((issue) => [issue.referencedPath, issue.references]));
    expect([...referencesByPath.keys()].sort()).toEqual(["Dockerfile", "docs/missing.md"]);
    expect(referencesByPath.get("docs/missing.md")).toEqual([
      { path: "Makefile", line: 2, text: "cat docs/missing.md" },
    ]);
    expect(referencesByPath.get("Dockerfile")).toEqual([
      { path: "README.md", line: 1, text: "See [container](Dockerfile)." },
    ]);
  });

  it("does not warn for path-like imports inside markdown fenced code blocks", async () => {
    fs.writeFileSync(
      path.join(repoDir, "README.md"),
      [
        "```typescript",
        "import { runCheckAgent } from './agents/mcp/check.js';",
        "```",
        "See docs/missing.md.",
        "",
      ].join("\n"),
    );
    git(repoDir, ["add", "README.md"]);
    git(repoDir, ["commit", "-m", "add markdown code sample"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toEqual([
      {
        referencedPath: "docs/missing.md",
        references: [
          { path: "README.md", line: 4, text: "See docs/missing.md." },
        ],
      },
    ]);
  });

  it("does not warn for extensionless imports or TypeScript-backed JavaScript runtime imports", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "existing.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "Runtime docs mention src/existing.js.\n");
    fs.writeFileSync(
      path.join(repoDir, "src", "index.ts"),
      [
        "import { value } from './existing.js';",
        "import './extensionless';",
        "import scoped from '@scope/pkg/file.js';",
        "void value;",
        "void scoped;",
      ].join("\n"),
    );
    git(repoDir, ["add", "README.md", "src/existing.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add import carve-out examples"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not warn for deleted paths handled by the git-status error rule", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "deleted.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "README.md"), "See src/deleted.ts while migrating.\n");
    git(repoDir, ["add", "src/deleted.ts", "README.md"]);
    git(repoDir, ["commit", "-m", "add deleted path reference"]);
    fs.rmSync(path.join(repoDir, "src", "deleted.ts"));

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not warn for generated build output targets in package scripts", async () => {
    fs.writeFileSync(
      path.join(repoDir, "package.json"),
      JSON.stringify({
        scripts: {
          server: "node dist/src/ai-backend/server.js",
          mcp: "node dist/mcp/server.js",
        },
      }),
    );
    git(repoDir, ["add", "package.json"]);
    git(repoDir, ["commit", "-m", "add package scripts"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("collects deleted-path errors and missing-file warnings with one diagnostics helper", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "deleted.ts"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(repoDir, "README.md"),
      "See src/deleted.ts and docs/missing.md while migrating.\n",
    );
    git(repoDir, ["add", "src/deleted.ts", "README.md"]);
    git(repoDir, ["commit", "-m", "add combined reference examples"]);
    fs.rmSync(path.join(repoDir, "src", "deleted.ts"));

    const diagnostics = await findFilenameReferenceDiagnosticsCancellable(repoDir);

    expect(diagnostics.deletedOrRenamedIssues.map((issue) => issue.oldPath)).toEqual(["src/deleted.ts"]);
    expect(diagnostics.nonexistentIssues.map((issue) => issue.referencedPath)).toEqual(["docs/missing.md"]);
  });

  it("does not treat an unrelated existing same-basename file as a move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "docs"));
    fs.writeFileSync(path.join(repoDir, "src", "duplicate.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "docs", "duplicate.ts"), "unrelated docs fixture\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './duplicate.ts';\n");
    git(repoDir, ["add", "src/duplicate.ts", "docs/duplicate.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add duplicate names"]);
    fs.rmSync(path.join(repoDir, "src", "duplicate.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/duplicate.ts");
    expect(issues[0].references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("does not treat an unrelated untracked same-basename file as a move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "scratch"));
    fs.writeFileSync(path.join(repoDir, "src", "untracked-name.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './untracked-name.ts';\n");
    git(repoDir, ["add", "src/untracked-name.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add untracked-name"]);
    fs.rmSync(path.join(repoDir, "src", "untracked-name.ts"));
    fs.writeFileSync(path.join(repoDir, "scratch", "untracked-name.ts"), "unrelated scratch file\n");

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/untracked-name.ts");
    expect(issues[0].references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("does not treat an unrelated edited same-basename file as a move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "docs"));
    fs.writeFileSync(path.join(repoDir, "src", "edited-name.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "docs", "edited-name.ts"), "unrelated docs fixture\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './edited-name.ts';\n");
    git(repoDir, ["add", "src/edited-name.ts", "docs/edited-name.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add edited-name"]);
    fs.rmSync(path.join(repoDir, "src", "edited-name.ts"));
    fs.writeFileSync(path.join(repoDir, "docs", "edited-name.ts"), "unrelated docs fixture changed\n");

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/edited-name.ts");
    expect(issues[0].references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("does not treat an unrelated same-basename rename as a move", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "docs"));
    fs.mkdirSync(path.join(repoDir, "notes"));
    fs.writeFileSync(path.join(repoDir, "src", "shared.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "docs", "shared.ts"), "unrelated docs fixture\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './shared.ts';\n");
    git(repoDir, ["add", "src/shared.ts", "docs/shared.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add shared names"]);
    fs.rmSync(path.join(repoDir, "src", "shared.ts"));
    fs.renameSync(path.join(repoDir, "docs", "shared.ts"), path.join(repoDir, "notes", "shared.ts"));
    git(repoDir, ["add", "-A"]);

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    const deletedIssue = issues.find((issue) => issue.oldPath === "src/shared.ts");
    expect(deletedIssue).toBeTruthy();
    expect(deletedIssue?.references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("reports references after a git rename to a different basename", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.writeFileSync(path.join(repoDir, "src", "old-name.ts"), "export const value = 1;\n");
    fs.writeFileSync(path.join(repoDir, "src", "index.ts"), "import './old-name.ts';\n");
    git(repoDir, ["add", "src/old-name.ts", "src/index.ts"]);
    git(repoDir, ["commit", "-m", "add old-name"]);
    fs.renameSync(path.join(repoDir, "src", "old-name.ts"), path.join(repoDir, "src", "new-name.ts"));
    git(repoDir, ["add", "-A"]);

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(1);
    expect(issues[0].oldPath).toBe("src/old-name.ts");
    expect(issues[0].changeType).toBe("renamed");
    expect(issues[0].references.map((ref) => ref.path)).toEqual(["src/index.ts"]);
  });

  it("ignores historical scenario fixture text when checking deleted filename references", async () => {
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "scenarios", "expected-to-fail"), { recursive: true });
    fs.writeFileSync(path.join(repoDir, "src", "removed.ts"), "export const value = 1;\n");
    fs.writeFileSync(
      path.join(repoDir, "scenarios", "expected-to-fail", "capture.json"),
      JSON.stringify({ transcript: [{ content: "removed.ts appeared in an old captured ls output" }] }),
    );
    git(repoDir, ["add", "src/removed.ts", "scenarios/expected-to-fail/capture.json"]);
    git(repoDir, ["commit", "-m", "add removed file and capture"]);
    fs.rmSync(path.join(repoDir, "src", "removed.ts"));

    const issues = await findDeletedOrRenamedFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
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

  it("applies prepared normalized moves only to their owning repo", async () => {
    const mainDir = fs.mkdtempSync(path.join(os.tmpdir(), "af-git-utils-main-"));
    try {
      git(mainDir, ["init"]);
      git(mainDir, ["config", "user.email", "test@example.com"]);
      git(mainDir, ["config", "user.name", "Test User"]);
      fs.mkdirSync(path.join(mainDir, "src"));
      fs.mkdirSync(path.join(mainDir, "lib"));
      fs.writeFileSync(path.join(mainDir, "src", "main.ts"), "export const main = 1;\n");
      git(mainDir, ["add", "src/main.ts"]);
      git(mainDir, ["commit", "-m", "add main"]);

      const siblingDir = path.join(mainDir, "sibling");
      fs.mkdirSync(siblingDir);
      git(siblingDir, ["init"]);
      git(siblingDir, ["config", "user.email", "test@example.com"]);
      git(siblingDir, ["config", "user.name", "Test User"]);
      fs.mkdirSync(path.join(siblingDir, "src"));
      fs.mkdirSync(path.join(siblingDir, "lib"));
      fs.writeFileSync(path.join(siblingDir, "src", "sibling.ts"), "export const sibling = 1;\n");
      git(siblingDir, ["add", "src/sibling.ts"]);
      git(siblingDir, ["commit", "-m", "add sibling"]);

      fs.rmSync(path.join(mainDir, "src", "main.ts"));
      fs.writeFileSync(path.join(mainDir, "lib", "main.ts"), "export const main = 1;\n");
      fs.rmSync(path.join(siblingDir, "src", "sibling.ts"));
      fs.writeFileSync(path.join(siblingDir, "lib", "sibling.ts"), "export const sibling = 1;\n");

      const contexts = await getRepoGitContextsCancellable(
        [
          { path: siblingDir, name: "sibling" },
          { path: mainDir, name: "main" },
        ],
        {
          normalizeMovedRecreated: true,
          preparedNormalizedMovesByRepo: [
            {
              repoPath: siblingDir,
              moves: [{ oldPath: "src/sibling.ts", newPath: "lib/sibling.ts", similarity: 100, mode: "moved" }],
            },
            {
              repoPath: mainDir,
              moves: [{ oldPath: "src/main.ts", newPath: "lib/main.ts", similarity: 100, mode: "moved" }],
            },
          ],
        },
      );

      expect(contexts[0].changes.diff).toContain("rename from src/sibling.ts");
      expect(contexts[0].changes.diff).not.toContain("src/main.ts");
      expect(contexts[1].changes.diff).toContain("rename from src/main.ts");
      expect(contexts[1].changes.diff).not.toContain("src/sibling.ts");
    } finally {
      fs.rmSync(mainDir, { recursive: true, force: true });
    }
  });
});
