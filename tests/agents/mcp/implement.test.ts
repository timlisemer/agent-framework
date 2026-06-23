import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn(),
  runCheckAgent: vi.fn(),
  logAgentStarted: vi.fn(),
  logAgentResult: vi.fn(),
}));

vi.mock("../../../src/utils/agent-runner.js", () => ({
  runAgent: mocks.runAgent,
}));

vi.mock("../../../src/agents/mcp/check.js", () => ({
  runCheckAgent: mocks.runCheckAgent,
}));

vi.mock("../../../src/utils/logger.js", () => ({
  logAgentStarted: mocks.logAgentStarted,
  logAgentResult: mocks.logAgentResult,
}));

import { runImplementAgent } from "../../../src/agents/mcp/implement.js";
import { runValidateImplementationAgent } from "../../../src/agents/mcp/implement.js";
import { validateQuotedExtraContext } from "../../../src/agents/mcp/implementation-workflow.js";
import { getAgentFrameworkSessionDir } from "../../../src/utils/paths.js";
import { writeCurrentPlanSidecar } from "../../../src/utils/plan-source.js";
import { withEnvForTest } from "../../helpers/provider-env.js";

type TempPlanfileFixture = {
  workingDir: string;
  planfile: string;
};

type CurrentPlanFixture = TempPlanfileFixture & {
  home: string;
  transcriptPath: string;
  sessionDir: string;
};

async function withTempPlanfile<T>(
  prefix: string,
  fn: (fixture: TempPlanfileFixture) => Promise<T>,
): Promise<T> {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planfile = path.join(workingDir, "plan.md");
  fs.writeFileSync(planfile, "Plan");
  try {
    return await fn({ workingDir, planfile });
  } finally {
    fs.rmSync(workingDir, { recursive: true, force: true });
  }
}

async function withCurrentPlanSession<T>(
  input: {
    homePrefix: string;
    workPrefix: string;
    userText: string;
  },
  fn: (fixture: CurrentPlanFixture) => Promise<T>,
): Promise<T> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), input.homePrefix));
  const restoreEnv = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_ADAPTER: "claude" });
  try {
    return await withTempPlanfile(input.workPrefix, async ({ workingDir, planfile }) => {
      const transcriptPath = path.join(workingDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({ message: { role: "user", content: input.userText } })}\n`);
      const sessionDir = getAgentFrameworkSessionDir({ transcriptPath, projectDir: workingDir });
      writeCurrentPlanSidecar(sessionDir, { kind: "file", path: planfile });
      return fn({ home, workingDir, planfile, transcriptPath, sessionDir });
    });
  } finally {
    restoreEnv();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe("implement MCP workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runAgent
      .mockResolvedValueOnce({ output: "implemented", success: true })
      .mockResolvedValueOnce({ output: "### Status: PASS", success: true });
    mocks.runCheckAgent.mockResolvedValue("## Results\n- Status: PASS");
  });

  it("runs write implementer, parent check, then read-only validator", async () => {
    await withTempPlanfile("agent-framework-implement-test-", async ({ workingDir, planfile }) => {
      const result = await runImplementAgent({ planfile, model_tier: "sonnet" }, { workingDir });

      expect(result).toContain("implemented");
      expect(result).toContain("### Status: PASS");
      expect(mocks.runAgent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ runtimeHomeProfile: "internalWrite", sdkToolPolicy: "write" }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(mocks.runCheckAgent).toHaveBeenCalledWith(workingDir, undefined, expect.any(Object));
      expect(mocks.runAgent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ runtimeHomeProfile: "internalReadOnly", sdkToolPolicy: "read-only" }),
        expect.any(Object),
        expect.any(Object),
      );
      expect(mocks.logAgentStarted).toHaveBeenNthCalledWith(
        1,
        "implement",
        expect.stringContaining("implement"),
      );
      expect(mocks.logAgentStarted).toHaveBeenNthCalledWith(
        2,
        "implement-validator",
        expect.stringContaining("validate"),
      );
      expect(mocks.logAgentResult).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ output: "implemented" }),
        expect.objectContaining({
          agent: "implement",
          workingDir,
          executionType: "llm",
          decisionOverride: "CONFIRM",
          extraData: expect.objectContaining({ planfile, stage: "implement" }),
        }),
      );
      expect(mocks.logAgentResult).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ output: "### Status: PASS" }),
        expect.objectContaining({
          agent: "implement-validator",
          workingDir,
          executionType: "llm",
          decisionOverride: "CONFIRM",
          extraData: expect.objectContaining({ planfile, stage: "validator", status: "PASS" }),
        }),
      );
    });
  });

  it("honors input-only working_dir for implement relative planfiles", async () => {
    await withTempPlanfile("agent-framework-implement-input-working-dir-test-", async ({ workingDir, planfile }) => {
      const result = await runImplementAgent({ working_dir: workingDir, planfile: "plan.md" });

      expect(result).toContain("implemented");
      expect(result).toContain(planfile);
      expect(mocks.runCheckAgent).toHaveBeenCalledWith(workingDir, undefined, expect.any(Object));
    });
  });

  it("honors input-only working_dir for validate-only relative planfiles", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent.mockResolvedValueOnce({ output: "### Status: PASS", success: true });
    await withTempPlanfile("agent-framework-validate-input-working-dir-test-", async ({ workingDir, planfile }) => {
      const result = await runValidateImplementationAgent({ working_dir: workingDir, planfile: "plan.md" });

      expect(result).toContain("## Implementation Validation");
      expect(result).toContain(planfile);
      expect(mocks.runCheckAgent).toHaveBeenCalledWith(workingDir, undefined, expect.any(Object));
    });
  });

  it("stops before check and validation when the implementer fails", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent.mockResolvedValueOnce({
      output: "[SDK ERROR] No output received",
      success: false,
      errorCount: 1,
    });
    await withTempPlanfile("agent-framework-implement-failed-test-", async ({ workingDir, planfile }) => {
      const result = await runImplementAgent({ planfile, model_tier: "sonnet" }, { workingDir });

      expect(result).toContain("## Implementation Workflow");
      expect(result).toContain("ERROR: implementer failed before parent check and validation.");
      expect(result).toContain("[SDK ERROR] No output received");
      expect(mocks.runCheckAgent).not.toHaveBeenCalled();
      expect(mocks.runAgent).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps validate-only failed when parent check fails even if validator passes", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent.mockResolvedValueOnce({
      output: "### Status: PASS",
      success: true,
      errorCount: 0,
    });
    mocks.runCheckAgent.mockResolvedValue(`## Results
- Errors: 1
- Warnings: 0
- Status: FAIL

## Errors
typecheck failed`);
    await withTempPlanfile("agent-framework-validate-check-failed-test-", async ({ workingDir, planfile }) => {
      const result = await runValidateImplementationAgent({ planfile }, { workingDir });

      expect(result).toContain("## Implementation Validation");
      expect(result).toContain("### Status: FAIL");
      expect(result).toContain("Parent-owned check failed");
      expect(result).toContain("typecheck failed");
      expect(mocks.logAgentResult).toHaveBeenLastCalledWith(
        expect.objectContaining({ output: "### Status: PASS" }),
        expect.objectContaining({ decisionOverride: "DENY" }),
      );
    });
  });

  it("keeps implement workflow failed when parent check fails even if validator passes", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent
      .mockResolvedValueOnce({ output: "implemented", success: true, errorCount: 0 })
      .mockResolvedValueOnce({ output: "### Status: PASS", success: true, errorCount: 0 });
    mocks.runCheckAgent.mockResolvedValue(`## Results
- Errors: 1
- Warnings: 0
- Status: FAIL

## Errors
typecheck failed`);
    await withTempPlanfile("agent-framework-implement-check-failed-test-", async ({ workingDir, planfile }) => {
      const result = await runImplementAgent({ planfile }, { workingDir });

      expect(result).toContain("## Implementation Workflow");
      expect(result).toContain("## Check Result");
      expect(result).toContain("typecheck failed");
      expect(result).toContain("### Status: FAIL");
      expect(result).toContain("Parent-owned check failed");
      expect(mocks.runAgent).toHaveBeenCalledTimes(2);
    });
  });

  it("resolves omitted implement planfile from the working_dir current-plan sidecar", async () => {
    await withCurrentPlanSession(
      {
        homePrefix: "agent-framework-current-plan-home-",
        workPrefix: "agent-framework-current-plan-work-",
        userText: "implement",
      },
      async ({ workingDir, planfile }) => {
        const result = await runImplementAgent({ model_tier: "sonnet" }, { workingDir });

        expect(result).toContain(planfile);
        expect(mocks.runAgent.mock.calls[0][1].prompt).toContain(planfile);
      },
    );
  });

  it("resolves omitted validate_implementation planfile from the working_dir current-plan sidecar", async () => {
    await withCurrentPlanSession(
      {
        homePrefix: "agent-framework-current-validate-home-",
        workPrefix: "agent-framework-current-validate-work-",
        userText: "validate",
      },
      async ({ workingDir, planfile }) => {
        mocks.runAgent.mockReset();
        mocks.runAgent.mockResolvedValueOnce({ output: "validated", success: true });

        const result = await runValidateImplementationAgent({}, { workingDir });

        expect(result).toContain(planfile);
        expect(mocks.runAgent.mock.calls[0][1].prompt).toContain(planfile);
      },
    );
  });

  it("returns a structured failure when no explicit or current planfile exists", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-missing-plan-home-"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-missing-plan-work-"));
    const restoreEnv = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_ADAPTER: "claude" });
    try {
      const result = await runImplementAgent({}, { workingDir: dir });

      expect(result).toContain("## Implementation Workflow");
      expect(result).toContain("ERROR:");
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(mocks.runCheckAgent).not.toHaveBeenCalled();
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns structured failures when no transcript user text can prove extra context", async () => {
    await withTempPlanfile("agent-framework-extra-context-failed-test-", async ({ workingDir, planfile }) => {
      await expect(validateQuotedExtraContext(["assistant-created context"], workingDir))
        .resolves.toEqual({
          ok: false,
          error: "extra_context was provided, but no active transcript user text could be recovered to verify it.",
        });

      const result = await runImplementAgent({ planfile, extra_context: ["assistant-created context"] }, { workingDir });

      expect(result).toContain("## Implementation Workflow");
      expect(result).toContain("ERROR: extra_context was provided");
      expect(mocks.runAgent).not.toHaveBeenCalled();
      expect(mocks.runCheckAgent).not.toHaveBeenCalled();
    });
  });

  it("validates quoted extra context through the working_dir scoped session sidecar", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-implement-home-"));
    const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-implement-work-"));
    const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-implement-other-"));
    const restoreEnv = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_ADAPTER: "claude" });
    const originalCwd = process.cwd();
    try {
      const transcriptPath = path.join(workingDir, "transcript.jsonl");
      fs.writeFileSync(transcriptPath, `${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "quoted user text" }],
        },
      })}\n`);
      getAgentFrameworkSessionDir({ transcriptPath, projectDir: workingDir });
      process.chdir(otherDir);

      await expect(validateQuotedExtraContext(["quoted user text"], workingDir))
        .resolves.toEqual({ ok: true });
      await expect(validateQuotedExtraContext(["quoted user text"], otherDir))
        .resolves.toEqual({
          ok: false,
          error: "extra_context was provided, but no active transcript user text could be recovered to verify it.",
        });
    } finally {
      process.chdir(originalCwd);
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(workingDir, { recursive: true, force: true });
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it("passes validate-only quoted context as its own validator section", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-framework-validate-home-"));
    const restoreEnv = withEnvForTest({ HOME: home, AGENT_FRAMEWORK_ADAPTER: "claude" });
    try {
      await withTempPlanfile("agent-framework-validate-work-", async ({ workingDir, planfile }) => {
        const transcriptPath = path.join(workingDir, "transcript.jsonl");
        fs.writeFileSync(transcriptPath, `${JSON.stringify({
          message: {
            role: "user",
            content: [{ type: "text", text: "validator context" }],
          },
        })}\n`);
        getAgentFrameworkSessionDir({ transcriptPath, projectDir: workingDir });
        mocks.runAgent.mockReset();
        mocks.runAgent.mockResolvedValueOnce({ output: "validated", success: true });
        mocks.runCheckAgent.mockResolvedValue("## Results\n- Status: PASS");

        await runValidateImplementationAgent(
          { planfile, extra_context: ["validator context"] },
          { workingDir },
        );

        const validatorContext = mocks.runAgent.mock.calls[0][1].context;
        expect(validatorContext).toContain("QUOTED USER EXTRA CONTEXT");
        expect(validatorContext).toContain("validator context");
        expect(validatorContext).toContain("PARENT-OWNED CHECK SUMMARY");
        expect(validatorContext).not.toContain("IMPLEMENTER SUMMARY");
      });
    } finally {
      restoreEnv();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("returns failure-shaped validation when the validator returns an SDK sentinel", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent.mockResolvedValueOnce({
      output: "[SDK ERROR] No output received",
      success: false,
      errorCount: 1,
    });
    mocks.runCheckAgent.mockResolvedValue("## Results\n- Status: PASS");
    await withTempPlanfile("agent-framework-validator-sentinel-test-", async ({ workingDir, planfile }) => {
      const result = await runValidateImplementationAgent({ planfile }, { workingDir });

      expect(result).toContain("## Implementation Validation");
      expect(result).toContain("### Status: FAIL");
      expect(result).toContain("Validator agent failed or returned malformed output.");
      expect(result).toContain("[SDK ERROR] No output received");
    });
  });

  it("returns failure-shaped validation when the validator output is malformed", async () => {
    mocks.runAgent.mockReset();
    mocks.runAgent.mockResolvedValueOnce({
      output: "validated",
      success: true,
      errorCount: 0,
    });
    mocks.runCheckAgent.mockResolvedValue("## Results\n- Status: PASS");
    await withTempPlanfile("agent-framework-validator-malformed-test-", async ({ workingDir, planfile }) => {
      const result = await runValidateImplementationAgent({ planfile }, { workingDir });

      expect(result).toContain("## Implementation Validation");
      expect(result).toContain("### Status: FAIL");
      expect(result).toContain("Validator agent failed or returned malformed output.");
      expect(result).toContain("validated");
    });
  });
});
