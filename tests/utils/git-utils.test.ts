import { describe, it, expect } from "vitest";
import { classifyCommitSize } from "../../src/utils/git-utils.js";

describe("classifyCommitSize", () => {
  function diffStat(files: number, insertions: number, deletions: number) {
    return ` src/foo.ts | 5 +++--\n ${files} files changed, ${insertions} insertions(+), ${deletions} deletions(-)`;
  }

  it("classifies 1 file / 10 lines as SMALL", () => {
    const r = classifyCommitSize(diffStat(1, 5, 5), "", "");
    expect(r.size).toBe("SMALL");
    expect(r.filesChanged).toBe(1);
    expect(r.linesChanged).toBe(10);
  });

  it("classifies 3 files / 49 lines as SMALL (boundary)", () => {
    const r = classifyCommitSize(diffStat(3, 25, 24), "", "");
    expect(r.size).toBe("SMALL");
  });

  it("classifies 4 files / 49 lines as MEDIUM (file threshold)", () => {
    const r = classifyCommitSize(diffStat(4, 25, 24), "", "");
    expect(r.size).toBe("MEDIUM");
  });

  it("classifies 3 files / 50 lines as MEDIUM (line threshold)", () => {
    const r = classifyCommitSize(diffStat(3, 25, 25), "", "");
    expect(r.size).toBe("MEDIUM");
  });

  it("classifies 9 files / 199 lines as MEDIUM", () => {
    const r = classifyCommitSize(diffStat(9, 100, 99), "", "");
    expect(r.size).toBe("MEDIUM");
  });

  it("classifies 10 files / 100 lines as LARGE (file threshold)", () => {
    const r = classifyCommitSize(diffStat(10, 50, 50), "", "");
    expect(r.size).toBe("LARGE");
  });

  it("classifies 5 files / 200 lines as LARGE (line threshold)", () => {
    const r = classifyCommitSize(diffStat(5, 100, 100), "", "");
    expect(r.size).toBe("LARGE");
  });

  it("classifies 5 files / 201 lines as LARGE", () => {
    const r = classifyCommitSize(diffStat(5, 101, 100), "", "");
    expect(r.size).toBe("LARGE");
  });

  it("untracked-only commit: 3 new files / 100 added lines = MEDIUM", () => {
    const status = "?? a.ts\n?? b.ts\n?? c.ts\n";
    // Synthesize a diff of 100 added lines across the three files.
    const untrackedDiff = Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n");
    const r = classifyCommitSize("", untrackedDiff, status);
    expect(r.filesChanged).toBe(3);
    expect(r.linesChanged).toBe(100);
    expect(r.size).toBe("MEDIUM");
  });

  it("untracked-only commit: 11 new files / 5 lines = LARGE (file count alone)", () => {
    const status = Array.from({ length: 11 }, (_, i) => `?? f${i}.ts`).join("\n");
    const untrackedDiff = "+a\n+b\n+c\n+d\n+e";
    const r = classifyCommitSize("", untrackedDiff, status);
    expect(r.filesChanged).toBe(11);
    expect(r.size).toBe("LARGE");
  });

  it("mixed tracked + untracked sums correctly", () => {
    const status = "M  src/a.ts\n?? src/b.ts\n";
    const ds = diffStat(1, 5, 5);
    const untrackedDiff = "+new\n+content\n+three";
    const r = classifyCommitSize(ds, untrackedDiff, status);
    expect(r.filesChanged).toBe(2);
    expect(r.linesChanged).toBe(13);
    expect(r.size).toBe("SMALL");
  });

  it("ignores `+++` file marker lines when counting added lines", () => {
    const status = "?? a.ts\n";
    const untrackedDiff = "+++ b/a.ts\n+real line\n+another";
    const r = classifyCommitSize("", untrackedDiff, status);
    // 2 actual + lines, the +++ header is excluded
    expect(r.linesChanged).toBe(2);
  });

  it.each([
    [49, "SMALL"],
    [50, "MEDIUM"],
    [200, "LARGE"],
  ] as const)("uses authoritative untracked line count %i for %s sizing", (lines, size) => {
    const result = classifyCommitSize("", "+inventory text that must not be counted", "?? file.ts", lines);

    expect(result.linesChanged).toBe(lines);
    expect(result.size).toBe(size);
  });
});
