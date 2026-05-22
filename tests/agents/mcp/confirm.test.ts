import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const mocks = vi.hoisted(() => ({
  runCheckAgent: vi.fn(),
  runAgent: vi.fn(),
  getUncommittedChangesCancellable: vi.fn(),
}));

vi.mock("../../../src/agents/mcp/check.js", () => ({
  runCheckAgent: mocks.runCheckAgent,
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("../../../src/utils/git-utils.js", () => ({
  getUncommittedChangesCancellable: mocks.getUncommittedChangesCancellable,
}));

import { formatCheckFailure, runConfirmAgent } from "../../../src/agents/mcp/confirm.js";
import { getAgentFrameworkSessionDir, sessionCurrentPlanFile } from "../../../src/utils/paths.js";

describe("formatCheckFailure", () => {
  it("preserves check errors when confirm declines before investigation", () => {
    const checkResult = `## Results
- Errors: 2
- Warnings: 0
- Status: FAIL

## Errors
src/foo.ts:12: Type 'string' is not assignable to type 'number'.
src/bar.ts:8: 'unusedValue' is declared but its value is never read.

## Warnings
(none)`;

    const result = formatCheckFailure(checkResult, 2);

    expect(result).toContain("- Errors: 2");
    expect(result).toContain("## Check Errors");
    expect(result).toContain("src/foo.ts:12: Type 'string' is not assignable to type 'number'.");
    expect(result).toContain("src/bar.ts:8: 'unusedValue' is declared but its value is never read.");
    expect(result).toContain("DECLINED: check failed with 2 error(s); see Check Errors above.");
  });

  it("falls back to full check output when the errors section is missing", () => {
    const checkResult = "tool failed before producing structured sections";

    const result = formatCheckFailure(checkResult, 1);

    expect(result).toContain("tool failed before producing structured sections");
  });
});

describe("runConfirmAgent planfile context", () => {
  let tempDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "confirm-agent-"));
    mocks.runCheckAgent.mockResolvedValue(`## Results
- Errors: 0
- Warnings: 0
- Status: PASS

## Errors
(none)

## Warnings
(none)`);
    mocks.getUncommittedChangesCancellable.mockResolvedValue({
      status: " M src/example.ts",
      diff: "diff --git a/src/example.ts b/src/example.ts",
    });
    mocks.runAgent.mockResolvedValue({
      output: "## Verdict\nCONFIRMED: ok",
    });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("injects explicit optional_planfile content into confirm context", async () => {
    const planPath = path.join(tempDir, "plan.md");
    fs.writeFileSync(planPath, "Plan Name: test-plan\n\nImplement x.\n");

    const result = await runConfirmAgent(tempDir, "haiku", undefined, planPath);

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalled();
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE PATH:");
    expect(context).toContain(planPath);
    expect(context).toContain("PLANFILE CONTENT:");
    expect(context).toContain("Implement x.");
  });

  it("returns an error before check when explicit optional_planfile is unreadable", async () => {
    const missingPath = path.join(tempDir, "missing.md");

    const result = await runConfirmAgent(tempDir, "haiku", undefined, missingPath);

    expect(result).toContain("ERROR: optional_planfile was provided but could not be read");
    expect(result).toContain(missingPath);
    expect(mocks.runCheckAgent).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("returns an error before check when explicit optional_planfile is blank", async () => {
    const result = await runConfirmAgent(tempDir, "haiku", undefined, "  ");

    expect(result).toBe("ERROR: optional_planfile was provided but the planfile path is empty.");
    expect(mocks.runCheckAgent).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("continues without plan input when no session planfile is available", async () => {
    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalledWith(tempDir, undefined, expect.any(Object));
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE CONTEXT: No planfile was provided through optional_planfile");
    expect(context).toContain("Continue evaluating the code changes without plan input.");
  });

  it("continues without plan input when stored session planfile is empty", async () => {
    const transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });
    const planPath = path.join(tempDir, "empty-plan.md");
    fs.writeFileSync(planPath, "  \n");
    fs.writeFileSync(
      sessionCurrentPlanFile(sessionDir),
      JSON.stringify({ kind: "file", path: planPath, planName: "empty-plan" }) + "\n",
    );

    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE CONTEXT: No planfile was provided through optional_planfile");

    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("uses the current session when available", async () => {
    const transcriptPath = path.join(tempDir, "sidecar-transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: tempDir });
    const planPath = path.join(tempDir, "session-plan.md");
    fs.writeFileSync(planPath, "Plan Name: session-plan\n\nUse session plan.\n");
    fs.writeFileSync(
      sessionCurrentPlanFile(sessionDir),
      JSON.stringify({ kind: "file", path: planPath, planName: "session-plan" }) + "\n",
    );

    const result = await runConfirmAgent(tempDir, "haiku");

    expect(result).toContain("CONFIRMED");
    expect(mocks.runCheckAgent).toHaveBeenCalledWith(tempDir, undefined, expect.any(Object));
    const context = mocks.runAgent.mock.calls[0][1].context as string;
    expect(context).toContain("PLANFILE PATH:");
    expect(context).toContain(planPath);
    expect(context).toContain("Use session plan.");

    fs.rmSync(sessionDir, { recursive: true, force: true });
  });

  it("exposes optional_planfile on the confirm MCP schema", () => {
    const serverSource = fs.readFileSync(path.join(process.cwd(), "src/mcp/server.ts"), "utf-8");
    const start = serverSource.indexOf('server.registerTool(\n  "confirm"');
    const end = serverSource.indexOf('server.registerTool(\n  "commit"', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const confirmBlock = serverSource.slice(start, end);

    expect(confirmBlock).toContain("optional_planfile");
    expect(confirmBlock).not.toContain("transcript_path");
  });
});
