import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { canonicalHookRunId } from "../../src/entrypoints/host-hook.js";
import { mainPreToolUse } from "../../src/hooks/pre-tool-use.js";
import { mainPostToolUse } from "../../src/hooks/post-tool-use.js";
import { mainPostToolUseFailure } from "../../src/hooks/post-tool-use-failure.js";
import { getAgentFrameworkSessionDir } from "../../src/utils/paths.js";
import type { ToolPrediction } from "../../src/utils/prediction-schema.js";
import { canonicalHookState } from "../helpers/canonical-hook-state.js";
import {
  codexPlan3AfterAgentBatchRequirements,
  codexPlan3AfterFirstAgentRequirements,
  codexPlan3InitialAgentBatchRequirements,
} from "../helpers/workflow-requirements.js";
import { bashReadProofExcludedCommands } from "../helpers/bash-read-fixtures.js";
import { createTestScenarioRuntime } from "../helpers/scenario-runtime.js";
import { AGENT_FRAMEWORK_RULE_EXTENSION_ID } from "../../src/effects/rule-observability.js";
import { withEnvironmentForTest } from "../helpers/environment.js";

const mocks = vi.hoisted(() => ({
  exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  validateClaudeMd: vi.fn(),
  appealHelper: vi.fn().mockResolvedValue({ overturned: false }),
  evaluateRules: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: mocks.exitAfterFlush,
  };
});

vi.mock("../../src/agents/hooks/claude-md-validate.js", () => ({
  validateClaudeMd: mocks.validateClaudeMd,
}));

vi.mock("../../src/agents/hooks/tool-appeal.js", () => ({
  appealHelper: mocks.appealHelper,
}));

vi.mock("../../src/rules/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/rules/index.js")>(
    "../../src/rules/index.js",
  );
  return {
    ...actual,
    evaluateRules: mocks.evaluateRules,
  };
});

describe("pre-tool-use planfile writes", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let restoreEnvironment: () => void;
  let hookState: ReturnType<typeof canonicalHookState>;
  const getSessionState = (_sessionDir: string) => hookState;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-tool-use-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    restoreEnvironment = withEnvironmentForTest({
      AGENT_FRAMEWORK_ADAPTER: "codex",
      AGENT_FRAMEWORK_PROJECT_DIR: tempDir,
      AGENT_FRAMEWORK_SCENARIO_ROOT: path.join(tempDir, "scenario-runtime"),
    });
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    hookState = canonicalHookState({
      adapter: "codex",
      nativeSessionId: "session-pre",
      transcriptPath,
      projectDir: tempDir,
    });
    mocks.exitAfterFlush.mockClear();
    mocks.validateClaudeMd.mockReset();
    mocks.appealHelper.mockClear();
    mocks.appealHelper.mockResolvedValue({ overturned: false });
    mocks.evaluateRules.mockReset();
    mocks.evaluateRules.mockResolvedValue(null);
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreEnvironment();
  });

  it("does not run plan validation on every planfile edit", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "hooks", "pre-tool-use.ts"),
      "utf-8",
    );
    expect(source).not.toContain("validatePlanEdit");
    expect(source).not.toContain("runPlanValidation");
    expect(source).not.toContain("Plan-validate: file edit to the active adapter's plans root.");
  });

  it("validates every instruction file in a multi-file edit", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const claudePath = path.join(tempDir, "CLAUDE.md");
    fs.writeFileSync(agentsPath, "agents");
    fs.writeFileSync(claudePath, "claude");
    mocks.validateClaudeMd
      .mockResolvedValueOnce({ approved: true })
      .mockResolvedValueOnce({ approved: false, reason: "bad second file" });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          file_paths: [agentsPath, claudePath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).toHaveBeenCalledTimes(2);
    expect(mocks.validateClaudeMd.mock.calls.map((call) => call[0])).toEqual(["agents", "claude"]);
    expect(mocks.appealHelper).toHaveBeenCalledOnce();
    expect(mocks.appealHelper).toHaveBeenCalledWith(
      "Edit",
      expect.any(String),
      expect.any(String),
      "CLAUDE.md validation failed: bad second file",
      tempDir,
      "PreToolUse",
      expect.any(Object),
      "claude-md-validate blocked: CLAUDE.md validation failed: bad second file",
      undefined,
      expect.any(Object),
      expect.any(AbortSignal),
    );
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(
      0,
      expect.stringContaining("CLAUDE.md validation failed: bad second file"),
    );
    const runtime = createTestScenarioRuntime({ root: path.join(tempDir, "scenario-runtime") });
    const records = await runtime.recordsAfter(canonicalHookRunId("codex", transcriptPath), 0);
    expect(records.filter((record) =>
      record.eventType === "extension.observed" &&
      record.payload.extensionId === AGENT_FRAMEWORK_RULE_EXTENSION_ID &&
      String(record.payload.event).startsWith("rule.appeal.")
    )).toMatchObject([
      {
        eventType: "extension.observed",
        payload: {
          extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
          event: "rule.appeal.started",
          ruleId: "agent-framework.rule.claude-md-validate",
          reason: "CLAUDE.md validation failed: bad second file",
        },
      },
      {
        eventType: "extension.observed",
        payload: {
          extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
          event: "rule.appeal.completed",
          ruleId: "agent-framework.rule.claude-md-validate",
          overturned: false,
          gateNote: null,
        },
      },
    ]);
    expect((await hookState.snapshot()).toolCalls.at(-1)?.authorization.final).toBe("denied");
  });

  it("allows an instruction-file edit when tool appeal overturns validation", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "agents");
    mocks.validateClaudeMd.mockResolvedValueOnce({ approved: false, reason: "validator mistake" });
    mocks.appealHelper.mockResolvedValueOnce({
      overturned: true,
      gateNote: "User explicitly approved the instruction update",
    });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-overturned-instruction",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          old_string: "agents",
          new_string: "agents updated",
        },
      },
      codexEncoder,
    );

    expect(mocks.appealHelper).toHaveBeenCalledOnce();
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
    const runtime = createTestScenarioRuntime({ root: path.join(tempDir, "scenario-runtime") });
    const records = await runtime.recordsAfter(canonicalHookRunId("codex", transcriptPath), 0);
    expect(records.filter((record) =>
      record.eventType === "extension.observed" &&
      record.payload.extensionId === AGENT_FRAMEWORK_RULE_EXTENSION_ID &&
      String(record.payload.event).startsWith("rule.appeal.")
    )).toMatchObject([
      {
        eventType: "extension.observed",
        payload: {
          extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
          event: "rule.appeal.started",
          ruleId: "agent-framework.rule.claude-md-validate",
          reason: "AGENTS.md validation failed: validator mistake",
        },
      },
      {
        eventType: "extension.observed",
        payload: {
          extensionId: AGENT_FRAMEWORK_RULE_EXTENSION_ID,
          event: "rule.appeal.completed",
          ruleId: "agent-framework.rule.claude-md-validate",
          overturned: true,
          gateNote: "User explicitly approved the instruction update",
        },
      },
    ]);
    expect(records.find((record) =>
      record.eventType === "effect.completed" && record.payload.result !== null &&
      typeof record.payload.result === "object" && !Array.isArray(record.payload.result) &&
      record.payload.result.kind === "toolPolicyEvaluation"
    )).toMatchObject({
      payload: {
        result: {
          decision: "allow",
          agent: "tool-appeal",
          gateNote: "User explicitly approved the instruction update",
        },
      },
    });
    expect((await hookState.snapshot()).toolCalls.at(-1)?.authorization.final).toBe("allowed");
  });

  it("fails closed when an instruction file read fails for a reason other than missing", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    fs.mkdirSync(agentsPath);

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-unreadable-instruction",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          old_string: "agents",
          new_string: "agents updated",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).not.toHaveBeenCalled();
    expect(mocks.appealHelper).not.toHaveBeenCalled();
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(
      0,
      expect.stringMatching(/EISDIR|illegal operation on a directory/i),
    );
    expect((await hookState.snapshot()).toolCalls.at(-1)?.authorization.final).toBe("failed");
  });

  it("validates instruction files edited with MultiEdit", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "agents");
    mocks.validateClaudeMd.mockResolvedValueOnce({ approved: true });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-multiedit",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "MultiEdit",
        tool_input: {
          file_path: agentsPath,
          edits: [{ old_string: "agents", new_string: "agents updated" }],
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).toHaveBeenCalledTimes(1);
    expect(mocks.validateClaudeMd).toHaveBeenCalledWith(
      "agents",
      "MultiEdit",
      expect.objectContaining({
        edits: [{ old_string: "agents", new_string: "agents updated" }],
      }),
      tempDir,
      "PreToolUse",
      expect.any(AbortSignal),
    );
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });

  it("reads a relative instruction path from the canonical project directory", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "project agents");
    mocks.validateClaudeMd.mockResolvedValueOnce({ approved: true });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-relative-instruction",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: "AGENTS.md",
          old_string: "project agents",
          new_string: "project agents updated",
        },
      },
      codexEncoder,
    );

    expect(tempDir).not.toBe(process.cwd());
    expect(mocks.validateClaudeMd).toHaveBeenCalledWith(
      "project agents",
      "Edit",
      expect.objectContaining({ file_path: "AGENTS.md" }),
      tempDir,
      "PreToolUse",
      expect.any(AbortSignal),
    );
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });

  it("does not use instruction-file validation as the final allow for mixed edits", async () => {
    const agentsPath = path.join(tempDir, "AGENTS.md");
    const sourcePath = path.join(tempDir, "src", "main.ts");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(agentsPath, "agents");
    fs.writeFileSync(sourcePath, "source");
    mocks.validateClaudeMd.mockResolvedValueOnce({ approved: true });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-mixed",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: agentsPath,
          file_paths: [agentsPath, sourcePath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).toHaveBeenCalledTimes(1);
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });

  it("does not validate nested instruction-named files as host instruction files", async () => {
    const nestedAgentsPath = path.join(tempDir, "docs", "AGENTS.md");
    fs.mkdirSync(path.dirname(nestedAgentsPath), { recursive: true });
    fs.writeFileSync(nestedAgentsPath, "nested");

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-pre-nested-agents",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Edit",
        tool_input: {
          file_path: nestedAgentsPath,
          file_paths: [nestedAgentsPath],
          old_string: "old",
          new_string: "new",
        },
      },
      codexEncoder,
    );

    expect(mocks.validateClaudeMd).not.toHaveBeenCalled();
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
  });

  it("returns a nested Codex tool denial instead of waiting for an outer transcript call", async () => {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "call_outer_exec",
            name: "exec",
            input: {},
          }],
        },
      }) + "\n",
    );
    mocks.evaluateRules.mockResolvedValueOnce({
      decision: "deny",
      agent: "prediction-block",
      reason: "Workflow requires mcp__agent_framework__check before Bash.",
    });

    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "exec-7007897d-f958-4670-b5fb-5d436f12dc78",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "Bash",
        tool_input: { command: "sed -n '1,240p' SKILL.md" },
      },
      codexEncoder,
    );

    expect(mocks.exitAfterFlush).toHaveBeenCalledTimes(1);
    const [exitCode, stdout] = mocks.exitAfterFlush.mock.calls[0];
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Workflow requires mcp__agent_framework__check before Bash.",
      },
    });
  });

  it("subjects interactive write_stdin shell commands to canonical Bash policy", async () => {
    mocks.evaluateRules.mockResolvedValueOnce({
      decision: "deny",
      agent: "shell-policy-test",
      reason: "Interactive shell command denied by canonical policy.",
    });

    await runToolHook("pty-input-1", "write_stdin", {
      session_id: 42,
      chars: "rm -rf ./generated\n",
      yield_time_ms: 1_000,
    });

    const context = mocks.evaluateRules.mock.calls.at(-1)?.[1];
    expect(context).toMatchObject({
      toolName: "Bash",
      rawToolName: "write_stdin",
      rawToolInput: {
        session_id: 42,
        chars: "rm -rf ./generated\n",
      },
      toolInput: {
        command: "rm -rf ./generated\n",
        continuation_session_id: 42,
      },
    });
    const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
    expect(JSON.parse(stdout).hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "Interactive shell command denied by canonical policy.",
    });
    expect((await hookState.snapshot()).toolCalls.at(-1)).toMatchObject({
      name: "Bash",
      input: {
        command: "rm -rf ./generated\n",
        continuation_session_id: 42,
      },
      authorization: { final: "denied" },
    });
  });

  it("does not predict a Codex wait before the MCP result is known", async () => {
    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-check",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
  });

  it("consumes a required Read through Codex Bash before the native MCP call", async () => {
    const planfile = path.join(tempDir, "implementation-plan.md");
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "Read", input: { file_path: planfile } },
        { tool: "mcp-check" },
      ],
    });

    await runToolHook(
      "tool-read-plan",
      "Bash",
      { command: `sed -n '1,240p' '${planfile}'` },
    );

    let state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([
      { tool: "mcp-check" },
    ]);

    await runToolHook(
      "tool-check-after-read",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );

    state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([]);
    const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
    expect(stdout).toBe("");
  });

  it("does not consume Read for excluded Codex Bash read-proof forms", async () => {
    const planfile = path.join(tempDir, "conditional-plan.md");
    for (const [index, command] of bashReadProofExcludedCommands(planfile).slice(0, 4).entries()) {
      await seedPrediction({
        explicitlyRequiredTools: [
          { tool: "Read", input: { file_path: planfile } },
          { tool: "mcp-check" },
        ],
      });
      const toolUseId = `conditional-read-${index}`;
      writeToolBatch([
        { id: toolUseId, name: "Bash", input: { command } },
        {
          id: `conditional-check-${index}`,
          name: "mcp__agent_framework__check",
          input: { working_dir: tempDir },
        },
      ]);

      await runToolHook(toolUseId, "Bash", { command });

      const state = await getSessionState(sessionDir).load();
      expect(state.currentPrediction?.explicitlyRequiredTools, command).toEqual([
        { tool: "Read", input: { file_path: planfile } },
        { tool: "mcp-check" },
      ]);
      const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
      expect(JSON.parse(stdout).hookSpecificOutput.permissionDecision, command).toBe("deny");
    }
  });

  it("consumes the Codex wait continuation before allowing the next workflow tool", async () => {
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "mcp-check" },
        { tool: "Read" },
      ],
    });

    await runToolHook(
      "tool-check",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );
    await mainPostToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-check",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: "Script running with cell ID cell-check",
      },
      codexEncoder,
    );

    let state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["Wait", "Read"]);

    await runToolHook(
      "tool-wait",
      "wait",
      { cell_id: "cell-check", yield_time_ms: 330000 },
    );
    state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["Read"]);

    await mainPostToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-wait",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "wait",
        tool_input: { cell_id: "cell-check", yield_time_ms: 330000 },
        tool_response: "Status: PASS",
      },
      codexEncoder,
    );

    await runToolHook(
      "tool-read",
      "Bash",
      { command: `sed -n '1,240p' '${path.join(tempDir, "README.md")}'` },
    );
    state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([]);
  });

  it("re-queues the exact wait when the same cell is still running", async () => {
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "Wait", input: { cell_id: "cell-check", yield_time_ms: 330000 } },
        { tool: "Read" },
      ],
    });

    await runToolHook(
      "tool-wait",
      "wait",
      { cell_id: "cell-check", yield_time_ms: 330000 },
    );
    await mainPostToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "tool-wait",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "wait",
        tool_input: { cell_id: "cell-check", yield_time_ms: 330000 },
        tool_response: "Script running with cell ID cell-check",
      },
      codexEncoder,
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([
      {
        tool: "Wait",
        input: { cell_id: "cell-check", yield_time_ms: 330000 },
        reason: "Wait must continue the preceding MCP call for this adapter",
      },
      { tool: "Read" },
    ]);
  });

  it("restores a failed wait but treats an interrupted wait as cancelled", async () => {
    const waitRequirement = {
      tool: "Wait",
      input: { cell_id: "cell-check", yield_time_ms: 330000 },
    };
    await seedPrediction({
      explicitlyRequiredTools: [waitRequirement, { tool: "Read" }],
    });
    await runToolHook("tool-wait", "wait", waitRequirement.input);
    await mainPostToolUseFailure(
      {
        session_id: "session-pre",
        tool_name: "wait",
        tool_input: waitRequirement.input,
        error: "wait timed out",
        is_interrupt: false,
        transcript_path: transcriptPath,
        cwd: tempDir,
      },
      codexEncoder,
    );

    let state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["Wait", "Read"]);

    await runToolHook("tool-wait-retry", "wait", waitRequirement.input);
    await mainPostToolUseFailure(
      {
        session_id: "session-pre",
        tool_name: "wait",
        tool_input: waitRequirement.input,
        error: "user interrupted wait",
        is_interrupt: true,
        transcript_path: transcriptPath,
        cwd: tempDir,
      },
      codexEncoder,
    );
    state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["Read"]);
  });

  it("denies later workflow tools parallelized with a wait barrier", async () => {
    const waitInput = { cell_id: "cell-check", yield_time_ms: 330000 };
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "Wait", input: waitInput },
        { tool: "Read" },
      ],
    });
    writeToolBatch([
      { id: "tool-wait", name: "wait", input: waitInput },
      {
        id: "tool-read",
        name: "Read",
        input: { file_path: path.join(tempDir, "README.md") },
      },
    ]);

    await runToolHook("tool-wait", "wait", waitInput);

    const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason)
      .toContain("complete before later parallel tools");
    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["Wait", "Read"]);
  });

  it("does not pre-seed an orphan wait for an MCP behind a parallel leader", async () => {
    writeToolBatch([
      { id: "call-search", name: "tool_search", input: { query: "check MCP" } },
      {
        id: "call-check",
        name: "mcp__agent_framework__check",
        input: { working_dir: tempDir },
      },
    ]);

    await runToolHook("call-search", "tool_search", { query: "check MCP" });

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
  });

  it("does not pre-seed waits for parallel MCPs before their results", async () => {
    writeToolBatch([
      {
        id: "call-check",
        name: "mcp__agent_framework__check",
        input: { working_dir: tempDir },
      },
      {
        id: "call-confirm",
        name: "mcp__agent_framework__confirm",
        input: { working_dir: tempDir },
      },
    ]);

    await runToolHook(
      "call-check",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools ?? []).toEqual([]);
  });

  it("denies unqueued work parallelized after a Codex MCP continuation boundary", async () => {
    writeToolBatch([
      {
        id: "call-check",
        name: "mcp__agent_framework__check",
        input: { working_dir: tempDir },
      },
      {
        id: "call-read",
        name: "Read",
        input: { file_path: path.join(tempDir, "README.md") },
      },
    ]);

    await runToolHook(
      "call-check",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );

    const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason)
      .toContain("must complete before later parallel tools");
  });

  it("does not consume a queued MCP when later workflow work is parallelized", async () => {
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "mcp-check" },
        { tool: "Read" },
      ],
    });
    writeToolBatch([
      {
        id: "call-check",
        name: "mcp__agent_framework__check",
        input: { working_dir: tempDir },
      },
      {
        id: "call-read",
        name: "Read",
        input: { file_path: path.join(tempDir, "README.md") },
      },
    ]);

    await runToolHook(
      "call-check",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement) => requirement.tool))
      .toEqual(["mcp-check", "Read"]);
  });

  it("allows the next queued tool after a synchronous Codex MCP completes", async () => {
    const readInput = { file_path: path.join(tempDir, "README.md") };
    await seedPrediction({
      explicitlyRequiredTools: [
        { tool: "mcp-check" },
        { tool: "Read" },
      ],
    });
    writeToolBatch([{
      id: "call-check",
      name: "mcp__agent_framework__check",
      input: { working_dir: tempDir },
    }]);

    await runToolHook(
      "call-check",
      "mcp__agent_framework__check",
      { working_dir: tempDir },
    );
    await mainPostToolUse(
      {
        session_id: "session-pre",
        tool_use_id: "call-check",
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "mcp__agent_framework__check",
        tool_input: { working_dir: tempDir },
        tool_response: "Status: PASS",
      },
      codexEncoder,
    );
    writeToolBatch([{
      id: "call-read",
      name: "Read",
      input: readInput,
    }]);
    await runToolHook("call-read", "Read", readInput);

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([]);
  });

  it("denies a strict workflow parallel batch when a sibling has the wrong agent type", async () => {
    await seedPrediction({
      explicitlyRequiredTools: codexPlan3InitialAgentBatchRequirements(),
    });
    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
      { id: "call_plan_2", agent_type: "implementer" },
      { id: "call_plan_3", agent_type: "default" },
    ]);

    await runSpawnAgentHook("call_plan_1");

    const [exitCode, stdout] = mocks.exitAfterFlush.mock.calls[0];
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason)
      .toContain("subagent_type=\"default\"");
  });

  it("advances the required queue once for a valid strict workflow parallel batch", async () => {
    await seedPrediction({
      explicitlyRequiredTools: codexPlan3InitialAgentBatchRequirements(),
    });
    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
      { id: "call_plan_2", agent_type: "default" },
      { id: "call_plan_3", agent_type: "default" },
    ]);

    await runSpawnAgentHook("call_plan_1");

    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(0, "");
    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools)
      .toEqual(codexPlan3AfterAgentBatchRequirements());
  });

  it("mirrors full-batch siblings after the leader consumes the workflow queue", async () => {
    await seedPrediction({
      explicitlyRequiredTools: codexPlan3InitialAgentBatchRequirements(),
    });
    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
      { id: "call_plan_2", agent_type: "default" },
      { id: "call_plan_3", agent_type: "default" },
    ]);

    for (const id of ["call_plan_1", "call_plan_2", "call_plan_3"]) {
      await runSpawnAgentHook(id);
    }

    expect(mocks.exitAfterFlush.mock.calls.slice(-3)).toEqual([
      [0, ""],
      [0, ""],
      [0, ""],
    ]);
    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools)
      .toEqual(codexPlan3AfterAgentBatchRequirements());
  });

  it("advances required workflow tools for mirrored siblings in transcript flush races", async () => {
    await seedPrediction({
      explicitlyRequiredTools: codexPlan3InitialAgentBatchRequirements(),
    });

    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
    ]);
    await runSpawnAgentHook("call_plan_1");

    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
      { id: "call_plan_2", agent_type: "default" },
    ]);
    await runSpawnAgentHook("call_plan_2");

    await runSpawnAgentHook("call_plan_3");

    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools)
      .toEqual(codexPlan3AfterAgentBatchRequirements());
  });

  it("denies invalid mirrored siblings in transcript flush races", async () => {
    await seedPrediction({
      explicitlyRequiredTools: codexPlan3InitialAgentBatchRequirements(),
    });

    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
    ]);
    await runSpawnAgentHook("call_plan_1");

    writeAssistantBatch([
      { id: "call_plan_1", agent_type: "default" },
      { id: "call_plan_2", agent_type: "implementer" },
    ]);
    await runSpawnAgentHook("call_plan_2", "implementer");

    const [, stdout] = mocks.exitAfterFlush.mock.calls.at(-1)!;
    expect(JSON.parse(stdout).hookSpecificOutput.permissionDecisionReason)
      .toContain("subagent_type=\"default\"");
    const state = await getSessionState(sessionDir).load();
    expect(state.currentPrediction?.explicitlyRequiredTools)
      .toEqual(codexPlan3AfterFirstAgentRequirements());
  });

  async function seedPrediction(overrides: Partial<ToolPrediction>): Promise<void> {
    const stateManager = getSessionState(sessionDir);
    await stateManager.update((s) => ({
      ...s,
      currentPrediction: {
        mood: "neutral",
        trust: "normal",
        intent: "workflow test",
        blockedIntent: "",
        explicitlyAllowedTools: [],
        explicitlyBlockedSubstrings: [],
        userMessageSnippet: "workflow test",
        timestamp: Date.now(),
        ...overrides,
      },
    }));
  }

  async function runSpawnAgentHook(toolUseId: string, agentType = "default"): Promise<void> {
    await runToolHook(toolUseId, "spawn_agent", { agent_type: agentType });
  }

  async function runToolHook(
    toolUseId: string,
    toolName: string,
    toolInput: unknown,
  ): Promise<void> {
    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: toolUseId,
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: toolName,
        tool_input: toolInput,
      },
      codexEncoder,
    );
  }

  function writeAssistantBatch(calls: Array<{ id: string; agent_type: string }>): void {
    writeToolBatch(calls.map((call) => ({
      id: call.id,
      name: "spawn_agent",
      input: { agent_type: call.agent_type },
    })));
  }

  function writeToolBatch(calls: Array<{ id: string; name: string; input: unknown }>): void {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        message: {
          role: "assistant",
          content: calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        },
      }) + "\n",
    );
  }
});
