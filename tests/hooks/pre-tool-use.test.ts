import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { mainPreToolUse } from "../../src/hooks/pre-tool-use.js";
import { getAgentFrameworkSessionDir } from "../../src/utils/paths.js";
import { getSessionState } from "../../src/utils/session-store.js";
import type { ToolPrediction } from "../../src/utils/prediction-types.js";
import {
  codexPlan3AfterAgentBatchRequirements,
  codexPlan3AfterFirstAgentRequirements,
  codexPlan3InitialAgentBatchRequirements,
} from "../helpers/workflow-requirements.js";

const mocks = vi.hoisted(() => ({
  exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  validateClaudeMd: vi.fn(),
  appealHelper: vi.fn().mockResolvedValue({ overturned: false }),
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
    evaluateRules: vi.fn().mockResolvedValue(null),
  };
});

describe("pre-tool-use planfile writes", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let prevAdapter: string | undefined;
  let prevProjectDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pre-tool-use-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    prevProjectDir = process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    process.env.AGENT_FRAMEWORK_PROJECT_DIR = tempDir;
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    mocks.exitAfterFlush.mockClear();
    mocks.validateClaudeMd.mockReset();
    mocks.appealHelper.mockClear();
    mocks.appealHelper.mockResolvedValue({ overturned: false });
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
    if (prevProjectDir === undefined) delete process.env.AGENT_FRAMEWORK_PROJECT_DIR;
    else process.env.AGENT_FRAMEWORK_PROJECT_DIR = prevProjectDir;
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
    expect(mocks.exitAfterFlush).toHaveBeenCalledWith(
      0,
      expect.stringContaining("CLAUDE.md validation failed: bad second file"),
    );
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
    await mainPreToolUse(
      {
        session_id: "session-pre",
        tool_use_id: toolUseId,
        transcript_path: transcriptPath,
        cwd: tempDir,
        tool_name: "spawn_agent",
        tool_input: { agent_type: agentType },
      },
      codexEncoder,
    );
  }

  function writeAssistantBatch(calls: Array<{ id: string; agent_type: string }>): void {
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({
        message: {
          role: "assistant",
          content: calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: "spawn_agent",
            input: { agent_type: call.agent_type },
          })),
        },
      }) + "\n",
    );
  }
});
