import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { OperationCancelledError } from "../../../src/utils/cancellation.js";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runProcessCancellable: vi.fn(),
  findFilenameReferenceDiagnosticsCancellable: vi.fn(),
  getGitStatusCancellable: vi.fn(),
  getRepoInfoCancellable: vi.fn(),
  sortReposWithChangesSubmodulesFirst: vi.fn(),
  logAgentStarted: vi.fn(),
  logAgentResult: vi.fn(),
  setTranscriptPath: vi.fn(),
  getAgentFrameworkSessionDir: vi.fn(),
  reduceDriftDetectionWindow: vi.fn(),
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
  findFilenameReferenceDiagnosticsCancellable: mocks.findFilenameReferenceDiagnosticsCancellable,
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
  reduceDriftDetectionWindow: mocks.reduceDriftDetectionWindow,
}));

vi.mock("../../../src/utils/supplemental-diagnostics.js", () => ({
  runSupplementalDiagnosticProviders: mocks.runSupplementalDiagnosticProviders,
}));

import {
  appendDeterministicCheckErrors,
  appendDeterministicCheckWarnings,
  applyStatusOverride,
  checkInvocationsForRunner,
  promoteUnusedCodeToErrors,
  runCheckAgent,
} from "../../../src/agents/mcp/check.js";
import {
  CHECK_COMMAND_TIMEOUT_MS,
  CHECK_SUMMARY_GRACE_MS,
  runMcpToolWithTimeout,
} from "../../../src/mcp/timeout.js";

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

describe("appendDeterministicCheckErrors", () => {
  it("adds deterministic errors and forces FAIL", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`;

    const result = appendDeterministicCheckErrors(input, [
      "`src/index.ts`:1 still references deleted file `src/old.ts` (old filename `old.ts`): import './old.ts';",
    ]);

    expect(result).toContain("- Errors: 1");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("DETERMINISTIC CHECK ERRORS:");
    expect(result).toContain("`src/index.ts`:1 still references deleted file `src/old.ts`");
    expect(result).not.toMatch(/## Errors\s*\n\(none\)/);
  });
});

describe("appendDeterministicCheckWarnings", () => {
  it("adds deterministic warnings without forcing FAIL", () => {
    const input = `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`;

    const result = appendDeterministicCheckWarnings(input, [
      "`README.md`:1 references missing file `docs/missing.md`: See docs/missing.md",
    ]);

    expect(result).toContain("- Errors: 0");
    expect(result).toContain("- Warnings: 1");
    expect(result).toContain("- Status: PASS");
    expect(result).toContain("DETERMINISTIC CHECK WARNINGS:");
    expect(result).toContain("`README.md`:1 references missing file `docs/missing.md`");
    expect(result).not.toMatch(/## Warnings\s*\n\(none\)/);
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
    mocks.findFilenameReferenceDiagnosticsCancellable.mockResolvedValue({
      deletedOrRenamedIssues: [],
      nonexistentIssues: [],
    });
    mocks.getAgentFrameworkSessionDir.mockReturnValue(path.join(tempDir, ".agent-framework-session"));
    mocks.reduceDriftDetectionWindow.mockResolvedValue(undefined);
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
    vi.useRealTimers();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends supplemental diagnostics before CHECK_AGENT summarization", async () => {
    await runCheckAgent(tempDir);

    expect(mocks.reduceDriftDetectionWindow).toHaveBeenCalledWith(path.join(tempDir, ".agent-framework-session"), 3);
    expect(mocks.runSupplementalDiagnosticProviders).toHaveBeenCalledWith(tempDir, expect.any(Object));
    expect(mocks.runAgent).toHaveBeenCalled();
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("UNCOMMITTED FILES:\n M src/example.ts");
    expect(context).toContain("CHECK OUTPUT: No Justfile or Makefile found.");
    expect(context).toContain("TYPESCRIPT LANGUAGE SERVICE DIAGNOSTICS:");
    expect(context).toContain("src/example.ts:1:1 warning TS6385: deprecated");
  });

  it("prefers a safe package lint script over raw eslint dot", async () => {
    fs.writeFileSync(path.join(tempDir, "eslint.config.js"), "export default [];\n");
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint src" } }),
    );
    mocks.runProcessCancellable.mockResolvedValue({
      output: "lint passed",
      exitCode: 0,
    });

    await runCheckAgent(tempDir);

    expect(mocks.runProcessCancellable).toHaveBeenCalledWith(
      { shell: true, command: "npm run lint 2>&1" },
      tempDir,
      expect.objectContaining({
        commandTimeoutMs: CHECK_COMMAND_TIMEOUT_MS,
        preserveTailOnTruncate: true,
      }),
    );
  });

  it("preserves failing TypeScript linter output in the final check result", async () => {
    fs.writeFileSync(path.join(tempDir, "eslint.config.js"), "export default [];\n");
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint src" } }),
    );
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\ttrue\n");
    mocks.runProcessCancellable.mockImplementation(async (command: { command?: string }) =>
      command.command === "npm run lint 2>&1"
        ? {
            output: "src/example.ts:4:7 error TS2322: Type 'string' is not assignable to type 'number'.",
            exitCode: 1,
          }
        : {
            output: "check passed",
            exitCode: 0,
          }
    );
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`,
    });

    const result = await runCheckAgent(tempDir);

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("LINTER OUTPUT (exit code 1):");
    expect(context).toContain("src/example.ts:4:7 error TS2322");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("LINTER OUTPUT (exit code 1):");
    expect(result).toContain("Type 'string' is not assignable to type 'number'");
  });

  it("clips large command output before CHECK_AGENT summarization", async () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\ttrue\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: `${"a".repeat(400_000)}tail-marker`,
      exitCode: 0,
    });

    await runCheckAgent(tempDir);

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("[agent-framework: check context truncated");
    expect(context).toContain("tail-marker");
    expect(Buffer.byteLength(context, "utf-8")).toBeLessThan(800_000);
  });

  it("preserves timed-out check output for summarization and deterministic failure", async () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\tfalse\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "last useful line before timeout\n[agent-framework: command timed out after 300 seconds; process terminated]",
      exitCode: 124,
      timedOut: true,
      timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
    });
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`,
    });

    const result = await runCheckAgent(tempDir);

    expect(mocks.runProcessCancellable).toHaveBeenCalledWith(
      { shell: true, command: "make check 2>&1" },
      tempDir,
      expect.objectContaining({
        commandTimeoutMs: CHECK_COMMAND_TIMEOUT_MS,
        preserveTailOnTruncate: true,
      }),
    );
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("MAKE CHECK OUTPUT (exit code 124, timed out after 300 seconds):");
    expect(context).toContain("last useful line before timeout");
    expect(context).toContain("[agent-framework: command timed out after 300 seconds; process terminated]");
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("MAKE CHECK OUTPUT (exit code 124, timed out after 300 seconds):");
    expect(result).toContain("last useful line before timeout");
  });

  it.each(["check", "confirm"] as const)(
    "returns deterministic check failure when %s-invoked summary exceeds post-timeout grace",
    async (toolName) => {
      vi.useFakeTimers();
      fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\tfalse\n");
      mocks.runProcessCancellable.mockResolvedValue({
        output: "last useful line before timeout\n[agent-framework: command timed out after 300 seconds; process terminated]",
        exitCode: 124,
        timedOut: true,
        timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
      });
      let resolveAgentStarted!: () => void;
      const agentStarted = new Promise<void>((resolve) => {
        resolveAgentStarted = resolve;
      });
      mocks.runAgent.mockImplementation(async (_config, _input, options) => {
        resolveAgentStarted();
        return new Promise((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new OperationCancelledError()),
            { once: true },
          );
        });
      });

      const running = runMcpToolWithTimeout(toolName, undefined, (signal) =>
        runCheckAgent(tempDir, undefined, { signal })
      );
      await agentStarted;
      await vi.advanceTimersByTimeAsync(CHECK_SUMMARY_GRACE_MS);

      const result = await running;

      expect(result).toContain("- Status: FAIL");
      expect(result).toContain("MAKE CHECK OUTPUT (exit code 124, timed out after 300 seconds):");
      expect(result).toContain("last useful line before timeout");
      expect(result).toContain("Check summarizer timed out after 30 seconds summary grace");
    },
  );

  it("returns deterministic check failure when confirm-invoked summarizer ignores abort", async () => {
    vi.useFakeTimers();
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\tfalse\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "last useful line before timeout\n[agent-framework: command timed out after 300 seconds; process terminated]",
      exitCode: 124,
      timedOut: true,
      timeoutMs: CHECK_COMMAND_TIMEOUT_MS,
    });
    let resolveAgentStarted!: () => void;
    const agentStarted = new Promise<void>((resolve) => {
      resolveAgentStarted = resolve;
    });
    mocks.runAgent.mockImplementation(async () => {
      resolveAgentStarted();
      return new Promise(() => undefined);
    });

    const running = runMcpToolWithTimeout("confirm", undefined, (signal) =>
      runCheckAgent(tempDir, undefined, { signal })
    );
    await agentStarted;
    await vi.advanceTimersByTimeAsync(CHECK_SUMMARY_GRACE_MS);

    const result = await running;

    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("MAKE CHECK OUTPUT (exit code 124, timed out after 300 seconds):");
    expect(result).toContain("last useful line before timeout");
    expect(result).toContain("Check summarizer timed out after 30 seconds summary grace");
  });

  it("forces FAIL when a failed command section is clipped out of summarizer context", async () => {
    const repos = ["repo-a", "repo-b", "repo-c", "repo-d", "repo-e"].map((name) => {
      const repoPath = path.join(tempDir, name);
      fs.mkdirSync(repoPath);
      fs.writeFileSync(path.join(repoPath, "Makefile"), "check:\n\tfalse\n");
      return { path: repoPath, name };
    });
    const repoInfo = {
      mainRepo: tempDir,
      mainRepoName: "main",
      mainRepoHasChanges: false,
      submodules: [],
      reposWithChanges: repos,
    };
    mocks.sortReposWithChangesSubmodulesFirst.mockReturnValue(repoInfo.reposWithChanges);
    mocks.getGitStatusCancellable.mockResolvedValue(" M src/example.ts");
    mocks.runSupplementalDiagnosticProviders.mockResolvedValue("");
    mocks.runProcessCancellable.mockImplementation(async (_command, cwd: string) => {
      const repoName = path.basename(cwd);
      const failed = repoName === "repo-c";
      return {
        output: `${repoName}\n${"x".repeat(300_000)}${failed ? "critical failure marker" : "ok"}`,
        exitCode: failed ? 1 : 0,
      };
    });
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`,
    });

    const result = await runCheckAgent(tempDir, undefined, {
      repoScope: { mode: "all", repoInfo },
    });

    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(Buffer.byteLength(context, "utf-8")).toBeLessThan(800_000);
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("MAKE CHECK OUTPUT for repo-c (exit code 1):");
    expect(result).toContain("critical failure marker");
  });

  it("appends deleted filename references as deterministic check errors", async () => {
    mocks.findFilenameReferenceDiagnosticsCancellable.mockResolvedValue({
      deletedOrRenamedIssues: [
        {
          oldPath: "src/old-helper.ts",
          oldBasename: "old-helper.ts",
          changeType: "deleted",
          references: [
            { path: "src/index.ts", line: 3, text: "import './old-helper.ts';" },
          ],
        },
      ],
      nonexistentIssues: [],
    });
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`,
    });

    const result = await runCheckAgent(tempDir);

    expect(mocks.findFilenameReferenceDiagnosticsCancellable).toHaveBeenCalledWith(tempDir, expect.any(Object));
    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("DETERMINISTIC CHECK ERRORS:");
    expect(result).toContain("`src/index.ts`:3 still references deleted file `src/old-helper.ts`");
    expect(result).toContain("import './old-helper.ts';");
  });

  it("appends nonexistent filename references as deterministic check warnings", async () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\ttrue\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "check passed",
      exitCode: 0,
    });
    mocks.findFilenameReferenceDiagnosticsCancellable.mockResolvedValue({
      deletedOrRenamedIssues: [],
      nonexistentIssues: [
        {
          referencedPath: "docs/missing.md",
          references: [
            { path: "README.md", line: 7, text: "See docs/missing.md for details." },
          ],
        },
      ],
    });
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)
`,
    });

    const result = await runCheckAgent(tempDir);

    expect(mocks.findFilenameReferenceDiagnosticsCancellable).toHaveBeenCalledWith(tempDir, expect.any(Object));
    expect(result).toContain("- Errors: 0");
    expect(result).toContain("- Warnings: 1");
    expect(result).toContain("- Status: PASS");
    expect(result).toContain("DETERMINISTIC CHECK WARNINGS:");
    expect(result).toContain("`README.md`:7 references missing file `docs/missing.md`");
    expect(result).toContain("See docs/missing.md for details.");
  });

  it("includes failing command output when the check summarizer returns a sentinel", async () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\tfalse\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "src/example.ts:1:1 error TS2304: Cannot find name 'missing'.",
      exitCode: 1,
    });
    mocks.runAgent.mockResolvedValue({
      output: "[SDK ERROR] No output received (messages=0, lastType=none)",
    });

    const result = await runCheckAgent(tempDir);

    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("MAKE CHECK OUTPUT (exit code 1):");
    expect(result).toContain("Cannot find name 'missing'");
    expect(result).toContain("[SDK ERROR] No output received");
  });

  it("falls back deterministically when runner format validation marks the summarizer failed", async () => {
    fs.writeFileSync(path.join(tempDir, "Makefile"), "check:\n\tfalse\n");
    mocks.runProcessCancellable.mockResolvedValue({
      output: "src/example.ts:1:1 error TS2304: Cannot find name 'missing'.",
      exitCode: 1,
    });
    mocks.runAgent.mockResolvedValue({
      output: `## Results
- Errors: 0
- Warnings: 0

## Errors
Check agent returned malformed output.

## Raw Output
[SDK ERROR] No output received (messages=0, lastType=none)`,
      success: false,
      errorCount: 1,
    });

    const result = await runCheckAgent(tempDir);

    expect(result).toContain("- Status: FAIL");
    expect(result).toContain("MAKE CHECK OUTPUT (exit code 1):");
    expect(result).toContain("Cannot find name 'missing'");
    expect(result).toContain("Check agent returned malformed output.");
    expect(result).toContain("[SDK ERROR] No output received");
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
