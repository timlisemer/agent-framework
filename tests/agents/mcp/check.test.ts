import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runProcessCancellable: vi.fn(),
  getGitStatusCancellable: vi.fn(),
  getRepoInfoCancellable: vi.fn(),
  sortReposWithChangesSubmodulesFirst: vi.fn(),
  logAgentStarted: vi.fn(),
  logAgentResult: vi.fn(),
  setTranscriptPath: vi.fn(),
  getAgentFrameworkSessionDir: vi.fn(),
  resetDriftDetectionWindow: vi.fn(),
  runSupplementalDiagnosticProviders: vi.fn(),
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("../../../src/utils/command.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/utils/command.js")>();
  return {
    ...actual,
    runProcessCancellable: mocks.runProcessCancellable,
  };
});

vi.mock("../../../src/utils/git-utils.js", () => ({
  getGitStatusCancellable: mocks.getGitStatusCancellable,
  getRepoInfoCancellable: mocks.getRepoInfoCancellable,
  sortReposWithChangesSubmodulesFirst: mocks.sortReposWithChangesSubmodulesFirst,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logAgentStarted: mocks.logAgentStarted,
  logAgentResult: mocks.logAgentResult,
}));

vi.mock("../../../src/utils/execution-context.js", () => ({
  setTranscriptPath: mocks.setTranscriptPath,
}));

vi.mock("../../../src/utils/paths.js", () => ({
  getAgentFrameworkSessionDir: mocks.getAgentFrameworkSessionDir,
}));

vi.mock("../../../src/scenario/lifecycle.js", () => ({
  resetDriftDetectionWindow: mocks.resetDriftDetectionWindow,
}));

vi.mock("../../../src/utils/supplemental-diagnostics.js", () => ({
  runSupplementalDiagnosticProviders: mocks.runSupplementalDiagnosticProviders,
}));

import {
  applyStatusOverride,
  checkInvocationsForRunner,
  promoteUnusedCodeToErrors,
  runCheckAgent,
} from "../../../src/agents/mcp/check.js";

describe("applyStatusOverride", () => {
  it("forces FAIL when Errors > 0 even if existing Status says PASS", () => {
    const input = `## Results
- Errors: 2
- Warnings: 0
- Status: PASS

## Errors
some error

## Warnings
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: FAIL");
    expect(r).not.toContain("- Status: PASS");
  });

  it("forces PASS when Errors == 0", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1
- Status: FAIL

## Warnings
unused something
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: PASS");
  });

  it("defensive floor bumps Errors to 1 when ## Errors body has content but count says 0", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
real error message here
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toContain("- Status: FAIL");
  });

  it("injects a Status line if missing", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0

## Errors
`;
    const r = applyStatusOverride(input);
    expect(r).toContain("- Status: PASS");
  });
});

describe("promoteUnusedCodeToErrors", () => {
  it("moves ESLint unused-var line from Warnings to Errors", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
src/foo.ts:5 'unused' is declared but its value is never read
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toContain("- Warnings: 0");
    expect(r).toMatch(/## Errors[\s\S]*declared but/);
  });

  it("moves Cargo 'unused variable' from Warnings to Errors", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: unused variable: \`x\`
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toMatch(/## Errors[\s\S]*unused variable/);
  });

  it("moves 'dead code' lint", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: dead code detected in module foo
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 1");
    expect(r).toMatch(/## Errors[\s\S]*dead code/);
  });

  it("leaves non-unused warnings in Warnings section", () => {
    const input = `## Results
- Errors: 0
- Warnings: 1

## Errors

## Warnings
warning: prefer const over let
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 0");
    expect(r).toContain("- Warnings: 1");
  });

  it("preserves existing errors and appends promoted lines", () => {
    const input = `## Results
- Errors: 1
- Warnings: 1

## Errors
type error in foo.ts

## Warnings
'x' is declared but never used
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toContain("- Errors: 2");
    expect(r).toContain("- Warnings: 0");
    expect(r).toContain("type error in foo.ts");
    expect(r).toMatch(/declared but never used/);
  });

  it("returns input unchanged when no warnings section present", () => {
    const input = `## Results
- Errors: 1

## Errors
some error
`;
    const r = promoteUnusedCodeToErrors(input);
    expect(r).toBe(input);
  });
});

describe("checkInvocationsForRunner", () => {
  it("runs agent-framework just checks once per registered adapter", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-check-"));
    fs.mkdirSync(path.join(dir, "src", "adapter"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "adapter", "spec.ts"), "");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "agent-framework" }));

    const invocations = checkInvocationsForRunner({ cmd: "just check 2>&1", dir, type: "just" });

    expect(invocations.map((invocation) => invocation.adapter)).toEqual(["claude", "codex"]);
    expect(invocations.map((invocation) => invocation.env?.AGENT_FRAMEWORK_ADAPTER)).toEqual(["claude", "codex"]);
  });

  it("does not multiply non-agent-framework project checks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "other-project-check-"));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "other-project" }));

    const invocations = checkInvocationsForRunner({ cmd: "just check 2>&1", dir, type: "just" });

    expect(invocations).toEqual([{ cmd: "just check 2>&1", dir, type: "just" }]);
  });

  it("does not multiply make checks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-check-"));
    fs.mkdirSync(path.join(dir, "src", "adapter"), { recursive: true });
    fs.writeFileSync(path.join(dir, "src", "adapter", "spec.ts"), "");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "agent-framework" }));

    const invocations = checkInvocationsForRunner({ cmd: "make check 2>&1", dir, type: "make" });

    expect(invocations).toEqual([{ cmd: "make check 2>&1", dir, type: "make" }]);
  });
});

describe("runCheckAgent supplemental diagnostics context", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "check-agent-context-"));
    mocks.getRepoInfoCancellable.mockResolvedValue({ mainRepo: tempDir });
    mocks.sortReposWithChangesSubmodulesFirst.mockImplementation((repoInfo) => repoInfo.reposWithChanges);
    mocks.getGitStatusCancellable.mockResolvedValue(" M src/example.ts");
    mocks.getAgentFrameworkSessionDir.mockReturnValue(path.join(tempDir, ".agent-framework-session"));
    mocks.resetDriftDetectionWindow.mockResolvedValue(undefined);
    mocks.runSupplementalDiagnosticProviders.mockResolvedValue(
      "TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:\nsrc/example.ts:1:1 warning TS6385: deprecated",
    );
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 1

## Errors
(none)

## Warnings
src/example.ts:1:1 warning TS6385: deprecated
`,
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends supplemental diagnostics before CHECK_AGENT summarization", async () => {
    await runCheckAgent(tempDir);

    expect(mocks.runSupplementalDiagnosticProviders).toHaveBeenCalledWith(tempDir, expect.any(Object));
    expect(mocks.runAgent).toHaveBeenCalled();
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("UNCOMMITTED FILES:\n M src/example.ts");
    expect(context).toContain("CHECK OUTPUT: No Justfile or Makefile found.");
    expect(context).toContain("TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:");
    expect(context).toContain("src/example.ts:1:1 warning TS6385: deprecated");
  });

  it("summarizes all-repos check context with one check-agent call", async () => {
    const subDir = path.join(tempDir, "sub");
    fs.mkdirSync(subDir);
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "main",
      mainRepoHasChanges: true,
      submodules: [],
      reposWithChanges: [
        { path: subDir, name: "sub" },
        { path: tempDir, name: "main" },
      ],
    };
    mocks.sortReposWithChangesSubmodulesFirst.mockReturnValue(repoInfo.reposWithChanges);
    mocks.getGitStatusCancellable
      .mockResolvedValueOnce(" M sub.ts")
      .mockResolvedValueOnce(" M main.ts");

    await runCheckAgent(tempDir, undefined, {
      repoScope: { mode: "all", repoInfo },
    });

    expect(mocks.getRepoInfoCancellable).not.toHaveBeenCalled();
    expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain(`=== sub (${subDir}) ===\n M sub.ts`);
    expect(context).toContain(`=== main (${tempDir}) ===\n M main.ts`);
  });

  it("preserves main-repo check fallback for subrepos in all-repos scope", async () => {
    const subDir = path.join(tempDir, "sub");
    fs.mkdirSync(subDir);
    fs.writeFileSync(path.join(tempDir, "Justfile"), "check:\n  echo main-check\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "main check passed",
      exitCode: 0,
    });
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "main",
      mainRepoHasChanges: false,
      submodules: [{ path: "sub", absolutePath: subDir, hasChanges: true }],
      reposWithChanges: [{ path: subDir, name: "sub" }],
    };
    mocks.sortReposWithChangesSubmodulesFirst.mockReturnValue(repoInfo.reposWithChanges);
    mocks.getGitStatusCancellable.mockResolvedValue(" M sub.ts");

    await runCheckAgent(tempDir, undefined, {
      repoScope: { mode: "all", repoInfo },
    });

    expect(mocks.runProcessCancellable).toHaveBeenCalledWith(
      { shell: true, command: "just check 2>&1" },
      tempDir,
      expect.any(Object),
    );
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("JUST CHECK OUTPUT for sub (from");
    expect(context).toContain("main check passed");
    expect(context).not.toContain("CHECK OUTPUT for sub: No Justfile or Makefile found.");
  });

  it("deduplicates shared main-repo fallback checks in all-repos scope", async () => {
    const subADir = path.join(tempDir, "sub-a");
    const subBDir = path.join(tempDir, "sub-b");
    fs.mkdirSync(subADir);
    fs.mkdirSync(subBDir);
    fs.writeFileSync(path.join(tempDir, "Justfile"), "check:\n  echo main-check\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "main check passed",
      exitCode: 0,
    });
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "main",
      mainRepoHasChanges: false,
      submodules: [
        { path: "sub-a", absolutePath: subADir, hasChanges: true },
        { path: "sub-b", absolutePath: subBDir, hasChanges: true },
      ],
      reposWithChanges: [
        { path: subADir, name: "sub-a" },
        { path: subBDir, name: "sub-b" },
      ],
    };
    mocks.sortReposWithChangesSubmodulesFirst.mockReturnValue(repoInfo.reposWithChanges);
    mocks.getGitStatusCancellable
      .mockResolvedValueOnce(" M sub-a.ts")
      .mockResolvedValueOnce(" M sub-b.ts");

    await runCheckAgent(tempDir, undefined, {
      repoScope: { mode: "all", repoInfo },
    });

    expect(mocks.runProcessCancellable).toHaveBeenCalledTimes(1);
    expect(mocks.runProcessCancellable).toHaveBeenCalledWith(
      { shell: true, command: "just check 2>&1" },
      tempDir,
      expect.any(Object),
    );
  });
});
