import { afterEach, describe, it, expect, vi } from "vitest";
import {
  sortReposSubmodulesFirst,
  parseUncertainties,
  elicitRepoSelection,
  elicitPreferences,
} from "../../src/utils/elicitation.js";
import type { RepoInfo } from "../../src/utils/git-utils.js";
import {
  DEFAULT_MCP_TIMEOUT_MS,
  MCP_NO_TIMEOUT_MS,
  runMcpToolWithTimeout,
} from "../../src/mcp/timeout.js";

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

describe("elicitPreferences", () => {
  it("uses Default/In depth/Broad-minimal review depth choices", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { model_tier: "opus", focus: "Default" },
    });

    const prefs = await elicitPreferences({ elicitInput } as never, "repo");

    expect(prefs).toEqual({ modelTier: "opus", focus: undefined });
    const schema = elicitInput.mock.calls[0][0].requestedSchema;
    expect(schema.properties.focus).toMatchObject({
      title: "Confirm review depth",
      enum: ["Default", "In depth", "Broad/minimal"],
      default: "Default",
    });
  });

  it("maps In depth to explicit confirm investigation instructions", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { model_tier: "opus", focus: "In depth" },
    });

    const prefs = await elicitPreferences({ elicitInput } as never, "repo");

    expect(prefs.focus).toContain("do not be lazy");
    expect(prefs.focus).toContain("Investigate thoroughly before confirming");
    expect(prefs.focus).toContain("deduplication/generic-code concerns");
  });

  it("maps Broad/minimal to lightweight review instructions", async () => {
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { model_tier: "sonnet", focus: "Broad/minimal" },
    });

    const prefs = await elicitPreferences({ elicitInput } as never, "repo");

    expect(prefs.modelTier).toBe("sonnet");
    expect(prefs.focus).toContain("broad but lightweight pass");
    expect(prefs.focus).toContain("without deep optional exploration");
  });
});

describe("elicitation cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes no-timeout and AbortSignal to MCP elicitation", async () => {
    const controller = new AbortController();
    const elicitInput = vi.fn().mockResolvedValue({
      action: "accept",
      content: { "/repo/a": true, "/repo/b": false },
    });
    const repoInfo: RepoInfo = {
      mainRepo: "/repo/a",
      mainRepoName: "a",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [
        { path: "/repo/a", name: "a" },
        { path: "/repo/b", name: "b" },
      ],
    };

    const selected = await elicitRepoSelection(
      { elicitInput } as never,
      repoInfo,
      { signal: controller.signal },
    );

    expect(selected).toEqual([{ path: "/repo/a", name: "a" }]);
    expect(elicitInput).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        timeout: MCP_NO_TIMEOUT_MS,
        signal: controller.signal,
      }),
    );
  });

  it("pauses MCP active-work timeout while elicitation is pending", async () => {
    vi.useFakeTimers();
    let resolveElicitation!: (value: {
      action: "accept";
      content: Record<string, boolean>;
    }) => void;
    let settled = false;
    const elicitInput = vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveElicitation = resolve;
    }));
    const repoInfo: RepoInfo = {
      mainRepo: "/repo/a",
      mainRepoName: "a",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [
        { path: "/repo/a", name: "a" },
        { path: "/repo/b", name: "b" },
      ],
    };

    const result = runMcpToolWithTimeout("check", undefined, async (signal) => {
      await elicitRepoSelection(
        { elicitInput } as never,
        repoInfo,
        { signal },
      );
      return new Promise(() => undefined);
    }).finally(() => {
      settled = true;
    });
    const assertion = expect(result).rejects.toMatchObject({
      name: "McpToolTimeoutError",
      toolName: "check",
    });

    await vi.advanceTimersByTimeAsync(DEFAULT_MCP_TIMEOUT_MS * 2);
    expect(settled).toBe(false);

    resolveElicitation({
      action: "accept",
      content: { "/repo/a": true, "/repo/b": false },
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DEFAULT_MCP_TIMEOUT_MS);

    await assertion;
  });
});
