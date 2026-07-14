// agent-framework-style-drift-ignore-file
import { describe, expect, it } from "vitest";
import {
  assertCompleteGitOutput,
  formatUnifiedDiffPath,
  formatPorcelainStatusZ,
  parsePorcelainStatusLine,
  parseUnifiedDiffDestination,
} from "../../src/utils/git-status.js";

describe("Git status codec", () => {
  it("round-trips NUL-delimited unusual rename paths", () => {
    const oldPath = "src/old -> name\nfile.ts";
    const newPath = "lib/new\t\"name\".ts";
    const formatted = formatPorcelainStatusZ(`R  ${newPath}\0${oldPath}\0`);

    expect(formatted.split("\n")).toHaveLength(1);
    expect(parsePorcelainStatusLine(formatted)).toEqual({
      indexStatus: "R",
      workTreeStatus: " ",
      oldPath,
      path: newPath,
    });
  });

  it("round-trips Git-quoted unified diff paths", () => {
    const pathname = "src/ä\\folder\tline\nname.ts";
    const header = `+++ ${formatUnifiedDiffPath(pathname, "b")}`;

    expect(header).toContain("\\303\\244");
    expect(header).toContain("\\\\folder\\tline\\nname.ts");
    expect(parseUnifiedDiffDestination(header)).toBe(pathname);
  });

  it("decodes the C-style octal paths emitted by Git", () => {
    expect(parseUnifiedDiffDestination("+++ \"b/src/\\303\\244\\\\folder\\tfile.ts\""))
      .toBe("src/ä\\folder\tfile.ts");
  });

  it("preserves raw non-BMP characters inside a quoted Git path", () => {
    expect(parseUnifiedDiffDestination("+++ \"b/src/😀\\tfile.ts\""))
      .toBe("src/😀\tfile.ts");
  });

  it("rejects bounded NUL output that is incomplete", () => {
    const result = (output: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) => ({
      output,
      exitCode: 0,
      stdoutTruncated,
      stdoutInvalidUtf8,
      stderrTruncated: false,
      stderrInvalidUtf8: false,
    });
    expect(() => assertCompleteGitOutput(result("?? partial"), "git status", true))
      .toThrow("git status output was truncated");
    expect(() => assertCompleteGitOutput(result("?? complete\0"), "git status", true))
      .not.toThrow();
    expect(() => assertCompleteGitOutput(result("?? complete\0", true), "git status", true))
      .toThrow("git status output was truncated");
    expect(() => assertCompleteGitOutput(result("?? complete\0", false, true), "git status", true))
      .toThrow("git status output was truncated");
    expect(() => assertCompleteGitOutput({ ...result("fatal error"), exitCode: 1 }, "git status", false))
      .toThrow("git status failed with exit code 1: fatal error");
    expect(() => assertCompleteGitOutput({ ...result("diff"), stderrTruncated: true }, "git diff", false))
      .toThrow("git diff output was truncated");
    expect(() => assertCompleteGitOutput({ ...result("diff"), stderrInvalidUtf8: true }, "git diff", false))
      .toThrow("git diff output was truncated");
  });
});
