// agent-framework-style-drift-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  prepareMovedRecreatedFile,
  runGitFixture as git,
} from "../helpers/git-fixtures.js";
import {
  formatGitContextForRepos,
  formatGitPathForContext,
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
  parsePorcelainStatusLine,
  sortReposWithChangesSubmodulesFirst,
} from "../../src/utils/git-utils.js";
import { selectConfirmPrefilterCandidateLines } from "../../src/utils/confirm-prefilter.js";
import { failFileHandleReadAfter } from "../helpers/file-read-failure.js";

type InventoryOpenHooks = {
  beforeOpen?: (absolutePath: string) => void | Promise<void>;
  afterOpen?: (
    absolutePath: string,
    handle: Awaited<ReturnType<typeof fs.promises.open>>,
  ) => void | Promise<void>;
  afterFirstStat?: (absolutePath: string) => void | Promise<void>;
  afterLstat?: (absolutePath: string, pathCall: number) => void | Promise<void>;
};

async function withInventoryOpenHooks<T>(
  hooks: InventoryOpenHooks,
  action: () => Promise<T>,
): Promise<T> {
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  const lstatCalls = new Map<string, number>();
  const lstatSpy = vi.spyOn(fs.promises, "lstat").mockImplementation((async (
    file: fs.PathLike,
    options?: Parameters<typeof fs.promises.lstat>[1],
  ) => {
    const result = await originalLstat(file, options as never);
    const absolutePath = String(file);
    const pathCall = (lstatCalls.get(absolutePath) ?? 0) + 1;
    lstatCalls.set(absolutePath, pathCall);
    await hooks.afterLstat?.(absolutePath, pathCall);
    return result;
  }) as typeof fs.promises.lstat);
  const originalOpen = fs.promises.open.bind(fs.promises);
  const openSpy = vi.spyOn(fs.promises, "open").mockImplementation((async (
    file: fs.PathLike,
    flags: string | number,
    mode?: fs.Mode,
  ) => {
    const absolutePath = String(file);
    await hooks.beforeOpen?.(absolutePath);
    const handle = await originalOpen(file, flags, mode);
    await hooks.afterOpen?.(absolutePath, handle);
    if (hooks.afterFirstStat) {
      const originalStat = handle.stat.bind(handle);
      let intercepted = false;
      handle.stat = (async (...args: Parameters<typeof handle.stat>) => {
        const result = await originalStat(...args);
        if (!intercepted) {
          intercepted = true;
          await hooks.afterFirstStat?.(absolutePath);
        }
        return result;
      }) as typeof handle.stat;
    }
    return handle;
  }) as typeof fs.promises.open);
  try {
    return await action();
  } finally {
    openSpy.mockRestore();
    lstatSpy.mockRestore();
  }
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

  function populateStatusBeyondBound(): void {
    for (let index = 0; index < 2300; index += 1) {
      const filename = `${index}-${"x".repeat(225)}.ts`;
      fs.writeFileSync(path.join(repoDir, filename), "x\n");
    }
  }

  it("reads status without requiring full diff collection", async () => {
    fs.writeFileSync(path.join(repoDir, "large-untracked.txt"), "x".repeat(256 * 1024));

    const status = await getGitStatusCancellable(repoDir);

    expect(status).toContain("?? large-untracked.txt");
    expect(status).not.toContain("x".repeat(1000));
  });

  it("rejects truncated status in the status-only collector", async () => {
    populateStatusBeyondBound();

    await expect(getGitStatusCancellable(repoDir)).rejects.toThrow(
      "git status output was truncated",
    );
  });

  it("rejects truncated status in uncommitted-change collection", async () => {
    populateStatusBeyondBound();

    await expect(getUncommittedChangesCancellable(repoDir)).rejects.toThrow(
      "git status output was truncated",
    );
  });

  it("summarizes large untracked files without embedding raw contents", async () => {
    fs.writeFileSync(path.join(repoDir, "large-untracked.txt"), "x".repeat(8 * 1024 * 1024));

    const changes = await getUncommittedChangesCancellable(repoDir);

    expect(changes.status).toContain("?? large-untracked.txt");
    expect(changes.untrackedInventory).toContain("UNTRACKED FILE INVENTORY");
    expect(changes.untrackedInventory).toContain("large-untracked.txt (text, 1 lines, 8388608 bytes");
    expect(changes.untrackedInventory).not.toContain("x".repeat(1000));
  });

  it("does not let a late binary marker consume another file's excerpt budget", async () => {
    fs.writeFileSync(
      path.join(repoDir, "a-binary.dat"),
      Buffer.concat([Buffer.from("text prefix\n"), Buffer.from([0]), Buffer.from("binary tail")]),
    );
    fs.writeFileSync(path.join(repoDir, "b-source.ts"), "export const retained = true;\n");

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedContentSourceMaxBytes: 64,
    });

    expect(changes.untrackedContentDiff).toContain("+++ b/b-source.ts");
    expect(changes.untrackedContentDiff).toContain("+export const retained = true;");
    expect(changes.untrackedContentDiff).not.toContain("text prefix");
  });

  it("clips untracked excerpts without corrupting multibyte characters", async () => {
    fs.writeFileSync(path.join(repoDir, "multibyte.ts"), "😀😀😀\n");

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedContentSourceMaxBytes: 6,
    });

    expect(changes.untrackedContentDiff).not.toContain("�");
    const addedContent = changes.untrackedContentDiff?.split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1))
      .join("\n") ?? "";
    expect(Buffer.byteLength(addedContent, "utf8")).toBeLessThanOrEqual(6);
  });

  it("labels oversized sparse files without buffering or embedding them", async () => {
    const sparsePath = path.join(repoDir, "oversized-untracked.txt");
    fs.writeFileSync(sparsePath, "start\n");
    fs.truncateSync(sparsePath, 65 * 1024 * 1024);

    const changes = await getUncommittedChangesCancellable(repoDir);

    expect(changes.untrackedInventory).toContain("oversized-untracked.txt (regular file, 68157440 bytes; metadata scan skipped: per-file safety limit)");
    expect(changes.untrackedInventory).not.toContain("start");
  });

  it("does not follow untracked symlinks while building inventory", async () => {
    const outsidePath = path.join(repoDir, "outside.txt");
    fs.writeFileSync(outsidePath, "sensitive target contents\n");
    fs.symlinkSync(outsidePath, path.join(repoDir, "untracked-link"));

    const changes = await getUncommittedChangesCancellable(repoDir);
    const inventory = await getGitVisibleFileInventoryCancellable(repoDir);

    expect(changes.untrackedInventory).toContain("untracked-link (symbolic link; not followed or read)");
    expect(changes.untrackedInventory).not.toContain("sensitive target contents");
    expect(inventory.skippedNonRegular).toBe(1);
    expect(inventory.skippedUnreadable).toBe(0);
  });

  it("cancels an active streamed inventory scan", async () => {
    fs.writeFileSync(path.join(repoDir, "streamed-untracked.txt"), Buffer.alloc(32 * 1024 * 1024, 120));
    const controller = new AbortController();
    const pending = withInventoryOpenHooks({
      afterOpen: (absolutePath) => {
        if (absolutePath.endsWith("streamed-untracked.txt")) controller.abort();
      },
    }, () => getUncommittedChangesCancellable(repoDir, { signal: controller.signal }));

    await expect(pending).rejects.toThrow();
  });

  it("honors cancellation after every awaited inventory metadata stage", async () => {
    const targetPath = path.join(repoDir, "metadata-cancel.txt");
    fs.writeFileSync(targetPath, "metadata\n");
    const collectors: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal: AbortSignal) => getUncommittedChangesCancellable(repoDir, { signal }),
      (signal: AbortSignal) => getGitVisibleFileInventoryCancellable(repoDir, { signal }),
    ];
    const stages: Array<(controller: AbortController) => InventoryOpenHooks> = [
      (controller) => ({
        afterLstat: (absolutePath, pathCall) => {
          if (absolutePath === targetPath && pathCall === 1) controller.abort();
        },
      }),
      (controller) => ({
        afterOpen: (absolutePath) => {
          if (absolutePath === targetPath) controller.abort();
        },
      }),
      (controller) => ({
        afterFirstStat: (absolutePath) => {
          if (absolutePath === targetPath) controller.abort();
        },
      }),
      (controller) => ({
        afterLstat: (absolutePath, pathCall) => {
          if (absolutePath === targetPath && pathCall === 2) controller.abort();
        },
      }),
    ];

    for (const collect of collectors) {
      for (const stage of stages) {
        const controller = new AbortController();
        const pending = withInventoryOpenHooks(
          stage(controller),
          () => collect(controller.signal),
        );
        await expect(pending).rejects.toMatchObject({ name: "OperationCancelledError" });
      }
    }
  });

  it("honors cancellation before classifying the final symlink inventory path", async () => {
    const targetPath = path.join(repoDir, "zz-final-link");
    fs.symlinkSync("tracked.txt", targetPath);
    const collectors: Array<(signal: AbortSignal) => Promise<unknown>> = [
      (signal: AbortSignal) => getUncommittedChangesCancellable(repoDir, { signal }),
      (signal: AbortSignal) => getGitVisibleFileInventoryCancellable(repoDir, { signal }),
    ];

    for (const collect of collectors) {
      const controller = new AbortController();
      const pending = withInventoryOpenHooks({
        afterLstat: (absolutePath) => {
          if (absolutePath === targetPath) controller.abort();
        },
      }, () => collect(controller.signal));
      await expect(pending).rejects.toMatchObject({ name: "OperationCancelledError" });
    }
  });

  it("does not follow a symlink replacement between metadata inspection and open", async () => {
    const victimPath = path.join(repoDir, "replacement-victim.txt");
    const targetPath = `${repoDir}-replacement-target.txt`;
    fs.writeFileSync(victimPath, "original\n");
    fs.writeFileSync(targetPath, "outside\ntarget\ncontents\n");
    try {
      const changes = await withInventoryOpenHooks({
        beforeOpen: (absolutePath) => {
          if (absolutePath !== victimPath) return;
          fs.rmSync(victimPath);
          fs.symlinkSync(targetPath, victimPath);
        },
      }, () => getUncommittedChangesCancellable(repoDir));

      expect(changes.untrackedInventory).toContain("replacement-victim.txt (unreadable");
    } finally {
      fs.rmSync(targetPath, { force: true });
    }
  });

  it("enforces the live byte limit when an opened file grows", async () => {
    const growingPath = path.join(repoDir, "growing-untracked.txt");
    fs.writeFileSync(growingPath, "initial\n");

    const inventory = await withInventoryOpenHooks({
      afterFirstStat: (absolutePath) => {
        if (absolutePath === growingPath) {
          fs.appendFileSync(growingPath, Buffer.alloc(65 * 1024 * 1024, 120));
        }
      },
    }, () => getGitVisibleFileInventoryCancellable(repoDir));

    expect(inventory.skippedFiles).toContainEqual(expect.objectContaining({
      path: "growing-untracked.txt",
      reason: "metadata scan skipped: per-file safety limit",
    }));
    expect(inventory.scannedBytes).toBeGreaterThan(64 * 1024 * 1024);
  });

  it("accounts for bytes consumed before an inventory read failure", async () => {
    const partialPath = path.join(repoDir, "partial-untracked.txt");
    fs.writeFileSync(partialPath, Buffer.alloc(80 * 1024, 120));

    const inventory = await withInventoryOpenHooks({
      afterOpen: (absolutePath, handle) => {
        if (absolutePath !== partialPath) return;
        failFileHandleReadAfter(handle, 1);
      },
    }, () => getGitVisibleFileInventoryCancellable(repoDir));

    expect(inventory.skippedFiles).toContainEqual(expect.objectContaining({
      path: "partial-untracked.txt",
      reason: "unreadable",
    }));
    expect(inventory.scannedBytes).toBeGreaterThanOrEqual(64 * 1024);
  });

  it("uses one unchanged context line around tracked diff hunks", async () => {
    fs.writeFileSync(
      path.join(repoDir, "tracked.txt"),
      ["one", "two", "three", "four", "five", "six", "seven", ""].join("\n"),
    );
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "expand tracked fixture"]);
    fs.writeFileSync(
      path.join(repoDir, "tracked.txt"),
      ["one", "two", "three", "changed", "five", "six", "seven", ""].join("\n"),
    );

    const changes = await getUncommittedChangesCancellable(repoDir);

    expect(changes.diff).toContain("@@ -3,3 +3,3 @@ two");
    expect(changes.diff).toContain(" three\n-four\n+changed\n five");
    expect(changes.diff).not.toContain("\n two\n");
    expect(changes.diff).not.toContain("\n six\n");
  });

  it("rejects a truncated tracked diff instead of presenting it as complete", async () => {
    fs.writeFileSync(path.join(repoDir, "large-tracked.txt"), "a\n");
    git(repoDir, ["add", "large-tracked.txt"]);
    git(repoDir, ["commit", "-m", "add large tracked fixture"]);
    fs.writeFileSync(path.join(repoDir, "large-tracked.txt"), "b".repeat(5 * 1024 * 1024));

    await expect(getUncommittedChangesCancellable(repoDir)).rejects.toThrow(
      "tracked diff output was truncated",
    );
  });

  it("lists every non-ignored untracked path without a file-count cutoff", async () => {
    for (let i = 0; i < 51; i++) {
      fs.writeFileSync(path.join(repoDir, `untracked-${String(i).padStart(2, "0")}.txt`), `${i}\n`);
    }

    const changes = await getUncommittedChangesCancellable(repoDir);

    expect(changes.untrackedInventory).toContain("untracked-00.txt");
    expect(changes.untrackedInventory).toContain("untracked-50.txt");
    expect(changes.untrackedInventory).not.toContain("skipped");
  });

  it("preserves exact untracked paths that Git would otherwise quote", async () => {
    const paths = [
      "unicode-ä.txt",
      "tab\tname.txt",
      "line\nbreak.txt",
      "back\\slash.txt",
    ];
    for (const relativePath of paths) {
      fs.writeFileSync(path.join(repoDir, relativePath), "one\ntwo\n");
    }

    const changes = await getUncommittedChangesCancellable(repoDir);

    for (const relativePath of paths) {
      expect(changes.untrackedInventory).toContain(
        `${formatGitPathForContext(relativePath)} (text, 2 lines`,
      );
    }
    expect(changes.untrackedLinesChanged).toBe(8);
  });

  it("retains compact deterministic prefilter candidates from untracked text", async () => {
    const tsIgnoreMarker = ["@ts", "ignore"].join("-");
    fs.writeFileSync(
      path.join(repoDir, "untracked-debug.ts"),
      `console.log("debug");\n// ${tsIgnoreMarker}\nexport const value = 1;\n`,
    );

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedLineMatcher: selectConfirmPrefilterCandidateLines,
    });

    expect(changes.untrackedMatchedLineDiff).toContain("+++ b/untracked-debug.ts");
    expect(changes.untrackedMatchedLineDiff).toContain("+console.log();");
    expect(changes.untrackedMatchedLineDiff).toContain(`+// ${tsIgnoreMarker}`);
    expect(changes.diff).not.toContain("console.log(\"debug\");");
  });

  it("propagates deterministic matcher failures", async () => {
    fs.writeFileSync(path.join(repoDir, "matcher-error.ts"), "export const value = true;\n");
    const matcherError = new Error("matcher failed");

    await expect(getUncommittedChangesCancellable(repoDir, {
      untrackedLineMatcher: () => {
        throw matcherError;
      },
    })).rejects.toBe(matcherError);
  });

  it("never matches incomplete fragments of an oversized logical line", async () => {
    const quotedDebugText = `const fixture = "${"x".repeat(140 * 1024)}console.log('fixture')";`;
    fs.writeFileSync(
      path.join(repoDir, "oversized-line.ts"),
      `${quotedDebugText}\nconsole.log("real");\n`,
    );

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedLineMatcher: selectConfirmPrefilterCandidateLines,
    });

    expect(changes.untrackedInventory).toContain("1 oversized logical line(s) skipped");
    expect(changes.untrackedMatchedLineDiff?.match(/console\.log/g)).toHaveLength(1);
    expect(changes.untrackedMatchedLineDiff).toContain("+console.log();");
    expect(changes.untrackedMatchedLineDiff).not.toContain("fixture");
  });

  it("retains a deterministic violation after character 2000", async () => {
    fs.writeFileSync(
      path.join(repoDir, "late-debug.ts"),
      `${"const value = 1; ".repeat(160)}console.log("late");\n`,
    );

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedLineMatcher: selectConfirmPrefilterCandidateLines,
    });

    expect(changes.untrackedMatchedLineDiff).toContain("+console.log();");
  });

  it("caps deterministic evidence and preserves the exact omitted-finding count", async () => {
    fs.writeFileSync(
      path.join(repoDir, "many-debug-lines.ts"),
      Array.from({ length: 25 }, (_, index) => `console.log(${index});`).join("\n") + "\n",
    );

    const changes = await getUncommittedChangesCancellable(repoDir, {
      untrackedLineMatcher: selectConfirmPrefilterCandidateLines,
    });

    expect(changes.untrackedMatchedLineDiff?.match(/^\+console\.log\(\);$/gm)).toHaveLength(20);
    expect(changes.untrackedOmittedMatchedLines).toEqual([
      { path: "many-debug-lines.ts", count: 5 },
    ]);
  });

  it("detects an exact moved+recreated file as a move", async () => {
    prepareMovedRecreatedFile(repoDir);

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
    prepareMovedRecreatedFile(repoDir, {
      oldContent: ["export function value() {", "  return 1;", "}", ""].join("\n"),
      newContent: ["export function value() {", "  return 2;", "}", ""].join("\n"),
      commitMessage: "add editable helper",
    });

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

  it("round-trips unusual normalized-move paths through one status record", async () => {
    const basename = "before -> after\n\"quoted\"\\name.ts";
    const oldPath = `src/${basename}`;
    const newPath = `lib/${basename}`;
    fs.mkdirSync(path.join(repoDir, "src"));
    fs.mkdirSync(path.join(repoDir, "lib"));
    fs.writeFileSync(path.join(repoDir, oldPath), "export const value = 1;\n");
    git(repoDir, ["add", oldPath]);
    git(repoDir, ["commit", "-m", "add unusual move fixture"]);
    fs.rmSync(path.join(repoDir, oldPath));
    fs.writeFileSync(path.join(repoDir, newPath), "export const value = 1;\n");

    const changes = await getUncommittedChangesCancellable(repoDir, { normalizeMovedRecreated: true });
    const renameLines = changes.status.split("\n").filter((line) => line.startsWith("R"));

    expect(renameLines).toHaveLength(1);
    expect(parsePorcelainStatusLine(renameLines[0])).toEqual({
      indexStatus: "R",
      workTreeStatus: " ",
      oldPath,
      path: newPath,
    });
  });

  it("normalizes moved+edited text files above the untracked diff synthesis limit", async () => {
    const largeLine = "x".repeat(3 * 1024 * 1024);
    prepareMovedRecreatedFile(repoDir, {
      oldPath: "src/large.ts",
      newPath: "lib/large.ts",
      oldContent: `${largeLine}\nexport const value = 1;\n`,
      newContent: `${largeLine}\nexport const value = 2;\n`,
      commitMessage: "add large",
    });

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
    prepareMovedRecreatedFile(repoDir);
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "base\nstaged later\n");
    git(repoDir, ["add", "tracked.txt"]);

    const changes = await getUncommittedChangesCancellable(repoDir, { normalizeMovedRecreated: true });

    expect(changes.diff).toContain("rename from src/helper.ts");
    expect(changes.diff).toContain("rename to lib/helper.ts");
    expect(changes.diff).toContain("+staged later");
    expect(git(repoDir, ["diff", "--cached", "--name-only"]).trim()).toBe("tracked.txt");
  });

  it("emits one normalized rename status for already-staged move pairs", async () => {
    prepareMovedRecreatedFile(repoDir, {
      oldPath: "src/renamed.ts",
      newPath: "lib/renamed.ts",
      commitMessage: "add renamed",
      staging: "move",
    });

    const changes = await getUncommittedChangesCancellable(repoDir, {
      normalizeMovedRecreated: true,
      preparedNormalizedMoves: [
        { oldPath: "src/renamed.ts", newPath: "lib/renamed.ts", similarity: 100, mode: "moved" },
      ],
    });

    expect(changes.status.split("\n").filter((line) => line.includes("renamed.ts"))).toEqual([
      "R  \"src/renamed.ts\" -> \"lib/renamed.ts\"",
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

  it("keeps scan-limited tracked paths visible in fullconfirm scope context", async () => {
    const oversizedPath = path.join(repoDir, "oversized-tracked.txt");
    fs.writeFileSync(oversizedPath, "start\n");
    git(repoDir, ["add", "oversized-tracked.txt"]);
    git(repoDir, ["commit", "-m", "add oversized fixture"]);
    fs.truncateSync(oversizedPath, 65 * 1024 * 1024);

    const result = await getRepoFullScopeContextsCancellable([
      { path: repoDir, name: "repo" },
    ]);

    expect(result.context).toContain("oversized-tracked.txt (skipped: metadata scan skipped: per-file safety limit, 68157440 bytes)");
    expect(result.repos[0].inventory.totalFiles).toBe(2);
    expect(result.repos[0].inventory.skippedScanLimited).toBe(1);
    expect(result.repos[0].inventory.skippedUnreadable).toBe(0);
  });

  it("escapes hostile tracked paths in fullconfirm inventory context", async () => {
    const hostilePath = "safe\n?? .env\n=== END DELETED FILES ===.txt";
    fs.writeFileSync(path.join(repoDir, hostilePath), "content\n");
    git(repoDir, ["add", hostilePath]);
    git(repoDir, ["commit", "-m", "add hostile path fixture"]);

    const result = await getRepoFullScopeContextsCancellable([{ path: repoDir, name: "repo" }]);

    expect(result.context).toContain(JSON.stringify(hostilePath));
    expect(result.context.split("\n")).not.toContain("?? .env");
    expect(result.context.split("\n")).not.toContain("=== END DELETED FILES ===.txt");
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

  it("does not warn for absolute runtime filesystem paths", async () => {
    fs.writeFileSync(
      path.join(repoDir, "runtime.yml"),
      "storage: /var/lib/service/state.json\nscript: /tmp/service/check.sh\n",
    );
    git(repoDir, ["add", "runtime.yml"]);
    git(repoDir, ["commit", "-m", "add runtime path examples"]);

    const issues = await findNonexistentFileReferenceIssuesCancellable(repoDir);

    expect(issues).toHaveLength(0);
  });

  it("does not treat a bracketed editor language selector as a filename", async () => {
    fs.writeFileSync(
      path.join(repoDir, "settings.json"),
      "{\n  \"[makefile]\": { \"editor.defaultFormatter\": \"example.formatter\" }\n}\n",
    );
    git(repoDir, ["add", "settings.json"]);
    git(repoDir, ["commit", "-m", "add editor language selector"]);

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
      "Create src/api/YourModelService.ts, src/stores/yourModelHelper.ts, and create `src/rules/my-rule.ts`.\n",
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
          untrackedInventory: "",
          untrackedLinesChanged: 0,
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
