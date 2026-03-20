import { describe, it, expect } from "vitest";
import { sortReposSubmodulesFirst, parseUncertainties } from "../../src/utils/elicitation.js";
import type { RepoInfo } from "../../src/utils/git-utils.js";

describe("sortReposSubmodulesFirst", () => {
  const mainRepoPath = "/home/user/project";
  const repoInfo: RepoInfo = {
    mainRepo: mainRepoPath,
    mainRepoName: "project",
    mainRepoHasChanges: true,
    submodules: [
      { path: "lib-a", absolutePath: "/home/user/project/lib-a", hasChanges: true },
      { path: "lib-b", absolutePath: "/home/user/project/lib-b", hasChanges: true },
    ],
    reposWithChanges: [],
  };

  it("returns empty for empty selection", () => {
    expect(sortReposSubmodulesFirst([], repoInfo)).toEqual([]);
  });

  it("puts submodules before main repo", () => {
    const selected = [
      { path: mainRepoPath, name: "project" },
      { path: "/home/user/project/lib-a", name: "lib-a" },
    ];
    const sorted = sortReposSubmodulesFirst(selected, repoInfo);
    expect(sorted[0].name).toBe("lib-a");
    expect(sorted[1].name).toBe("project");
  });

  it("handles selection with only main repo", () => {
    const selected = [{ path: mainRepoPath, name: "project" }];
    const sorted = sortReposSubmodulesFirst(selected, repoInfo);
    expect(sorted).toHaveLength(1);
    expect(sorted[0].name).toBe("project");
  });

  it("handles selection with only submodules", () => {
    const selected = [
      { path: "/home/user/project/lib-a", name: "lib-a" },
      { path: "/home/user/project/lib-b", name: "lib-b" },
    ];
    const sorted = sortReposSubmodulesFirst(selected, repoInfo);
    expect(sorted).toHaveLength(2);
    // All are submodules, order preserved
    expect(sorted[0].name).toBe("lib-a");
    expect(sorted[1].name).toBe("lib-b");
  });

  it("preserves relative order among submodules", () => {
    const selected = [
      { path: mainRepoPath, name: "project" },
      { path: "/home/user/project/lib-b", name: "lib-b" },
      { path: "/home/user/project/lib-a", name: "lib-a" },
    ];
    const sorted = sortReposSubmodulesFirst(selected, repoInfo);
    expect(sorted[0].name).toBe("lib-b");
    expect(sorted[1].name).toBe("lib-a");
    expect(sorted[2].name).toBe("project");
  });
});

describe("parseUncertainties", () => {
  it("returns empty when output does not contain 'DECLINED'", () => {
    expect(parseUncertainties("CONFIRMED\nAll looks good")).toEqual([]);
  });

  it("returns empty when DECLINED but no UNCERTAIN markers", () => {
    expect(parseUncertainties("DECLINED\nSome reason")).toEqual([]);
  });

  it("parses single UNCERTAIN marker with hyphen", () => {
    const output = "DECLINED\nUNCERTAIN: auth - Missing token validation";
    const result = parseUncertainties(output);
    expect(result).toEqual([{ category: "auth", description: "Missing token validation" }]);
  });

  it("parses multiple UNCERTAIN markers", () => {
    const output = "DECLINED\nUNCERTAIN: auth - Missing validation\nUNCERTAIN: perf - Slow query";
    const result = parseUncertainties(output);
    expect(result).toHaveLength(2);
    expect(result[0].category).toBe("auth");
    expect(result[1].category).toBe("perf");
  });

  it("parses UNCERTAIN markers with em dash", () => {
    const output = "DECLINED\nUNCERTAIN: scope \u2014 Unclear if tests needed";
    const result = parseUncertainties(output);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("scope");
    expect(result[0].description).toBe("Unclear if tests needed");
  });

  it("parses UNCERTAIN markers with en dash", () => {
    const output = "DECLINED\nUNCERTAIN: deps \u2013 New dependency added";
    const result = parseUncertainties(output);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("deps");
  });

  it("trims descriptions", () => {
    const output = "DECLINED\nUNCERTAIN: test -   Extra spaces   ";
    const result = parseUncertainties(output);
    expect(result[0].description).toBe("Extra spaces");
  });
});
