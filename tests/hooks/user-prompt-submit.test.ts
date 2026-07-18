import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterEncoder } from "../../src/adapter/types.js";

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/rules/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/rules/index.js")>(
    "../../src/rules/index.js",
  );
  return {
    ...actual,
    evaluateRulesForUserPromptSubmit: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/agents/hooks/plan-validate.js", () => ({
  checkPlanIntent: vi.fn().mockResolvedValue({ approved: true }),
}));

import { mainUserPromptSubmit } from "../../src/hooks/user-prompt-submit.js";
import { evaluateRulesForUserPromptSubmit } from "../../src/rules/index.js";
import { exitAfterFlush } from "../../src/utils/hook-bootstrap.js";
import { checkPlanIntent } from "../../src/agents/hooks/plan-validate.js";
import { decidePrediction } from "../../src/utils/prediction-types.js";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import {
  getAgentFrameworkSessionDir,
  sessionPlanFile,
} from "../../src/utils/paths.js";
import { canonicalHookState } from "../helpers/canonical-hook-state.js";
import {
  implementWorkflowRequirementSignatures,
  requirementSignature,
} from "../helpers/workflow-requirements.js";
import { withEnvironmentForTest } from "../helpers/environment.js";

const mockEvaluateRulesForUserPromptSubmit = vi.mocked(evaluateRulesForUserPromptSubmit);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);
const mockCheckPlanIntent = vi.mocked(checkPlanIntent);

const encoder: AdapterEncoder = {
  name: "test",
  encodePreToolUseAllow: () => ({ exitCode: 0, stdout: "" }),
  encodePreToolUseDeny: (reason: string) => ({ exitCode: 2, stdout: reason }),
  encodeStopBlock: (reason: string) => ({ exitCode: 2, stdout: reason }),
  encodeStopPass: () => ({ exitCode: 0, stdout: "" }),
  encodeOk: () => ({ exitCode: 0, stdout: "ok" }),
  encodeContext: (_event, message: string) => ({ exitCode: 0, stdout: `ctx:${message}` }),
  encodeError: (_event, message: string) => ({ exitCode: 1, stdout: message }),
};

describe("mainUserPromptSubmit slash/skill workflow bypass", () => {
  let tempDir: string;
  let transcriptPath: string;
  let sessionDir: string;
  let restoreEnvironment: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prompt-submit-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
    restoreEnvironment = withEnvironmentForTest({
      AGENT_FRAMEWORK_SCENARIO_ROOT: path.join(tempDir, "scenario-runtime"),
    });
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
    restoreEnvironment();
  });

  function hookState(adapter: string, nativeSessionId: string) {
    return canonicalHookState({
      adapter,
      nativeSessionId,
      transcriptPath,
      projectDir: tempDir,
    });
  }

  async function withAdapter(adapter: "claude" | "codex", callback: () => Promise<void>): Promise<void> {
    const restoreAdapter = withEnvironmentForTest({ AGENT_FRAMEWORK_ADAPTER: adapter });
    try {
      await callback();
    } finally {
      restoreAdapter();
    }
  }

  it("skips UserPromptSubmit rules for direct agent-framework slash commands", async () => {
    await withAdapter("claude", async () => {
      await mainUserPromptSubmit(
        {
          session_id: "session-slash",
          transcript_path: transcriptPath,
          delivery_id: "delivery-slash",
          cwd: tempDir,
          prompt: "/quickpush",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
    });
  });

  it("seeds strict workflow requirements for Claude slash command tags with args", async () => {
    await withAdapter("claude", async () => {
      await mainUserPromptSubmit(
        {
          session_id: "session-claude-plan3-args",
          transcript_path: transcriptPath,
          delivery_id: "delivery-claude-plan3-args",
          cwd: tempDir,
          prompt:
            "<command-message>plan3</command-message>\n" +
            "<command-name>/plan3</command-name>\n" +
            "<command-args>fix the workflow queue</command-args>",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      const state = await hookState("claude", "session-claude-plan3-args").load();
      expect(state.currentPrediction?.intent).toBe(
        "User invoked the plan3 workflow. Complete that workflow and report its result.",
      );
      expect(state.currentPrediction?.explicitlyRequiredTools?.map((requirement: {
        tool: string;
        input?: unknown;
      }) => ({
        tool: requirement.tool,
        input: requirement.input,
      }))).toEqual([
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "mcp-create_planfile", input: { continue_workflow: true } },
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "Agent", input: { subagent_type: "Plan" } },
        { tool: "ExitPlanMode", input: undefined },
      ]);
      expect(decidePrediction(
        state.currentPrediction,
        "Agent",
        { subagent_type: "Plan" },
        0,
      ).decision).toBe("allow");
    });
  });

  it("skips UserPromptSubmit rules for Codex agent-framework skill invocations", async () => {
    await withAdapter("codex", async () => {
      await mainUserPromptSubmit(
        {
          session_id: "session-skill",
          transcript_path: transcriptPath,
          delivery_id: "delivery-skill",
          cwd: tempDir,
          prompt: "$agent-framework-quickpush",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      const state = await hookState("codex", "session-skill").load();
      expect(state.currentPrediction?.intent).toBe(
        "User invoked the quickpush workflow. Complete that workflow and report its result.",
      );
      expect(state.currentPrediction?.userMessageFull).toContain("$agent-framework-quickpush");
      expect(state.currentPrediction?.explicitlyRequiredTools).toEqual([
        {
          tool: "mcp-commit",
          input: { model_tier: "haiku", skip_elicitation: true, auto_push: true },
          reason: "Call `mcp-commit` with:",
        },
      ]);
      expect(state.frustrationStreak).toBe(0);
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
    });
  });

  it("replaces stale frustrated prediction for workflow-only skill prompts", async () => {
    await withAdapter("codex", async () => {
      const canonicalState = hookState("codex", "session-stale-skill");
      await canonicalState.update((state) => ({
        ...state,
            toolCallCount: 0,
            currentEditIntent: false,
            previousEditIntent: null,
            editIntentTimestamp: 1,
            editIntentOverturnCount: 0,
            respondFirstChecked: true,
            currentPrediction: {
              mood: "frustrated",
              trust: "normal",
              intent: "The user is asking about a prior stub discussion.",
              blockedIntent: "",
              explicitlyAllowedTools: [],
              explicitlyBlockedSubstrings: [],
              blockAllTools: false,
              hasExplicitOverride: false,
              contextSwitch: "no",
              questionIsStalling: "n/a",
              userMessageFull: "what?? in what sense",
              userMessageSnippet: "what?? in what sense",
              timestamp: 1,
            },
            frustrationStreak: 2,
            currentWindowSize: 8,
            driftState: {},
            lastProcessedPlanApprovalToolUseId: null,
            lastUserMessageTimestamp: 1,
      }));

      await mainUserPromptSubmit(
        {
          session_id: "session-stale-skill",
          transcript_path: transcriptPath,
          delivery_id: "delivery-stale-skill",
          cwd: tempDir,
          prompt: "$agent-framework-implement",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      const state = await canonicalState.load();
      expect(state.currentPrediction?.mood).toBe("neutral");
      expect(state.currentPrediction?.intent).toBe(
        "User invoked the implement workflow. Complete that workflow and report its result.",
      );
      expect(state.currentPrediction?.userMessageFull).toContain("$agent-framework-implement");
      expect(state.currentPrediction?.userMessageFull).not.toContain("what??");
      expect(state.currentPrediction?.explicitlyRequiredTools?.map(requirementSignature))
        .toEqual(implementWorkflowRequirementSignatures());
      expect(state.frustrationStreak).toBe(0);
      expect(state.currentWindowSize).toBe(2);
    });
  });

  it("still runs UserPromptSubmit rules for ordinary prompts", async () => {
    await mainUserPromptSubmit(
      {
        session_id: "session-normal",
        transcript_path: transcriptPath,
        delivery_id: "delivery-normal",
        cwd: tempDir,
        prompt: "please fix the bug",
      },
      encoder,
    );

    expect(mockEvaluateRulesForUserPromptSubmit).toHaveBeenCalledTimes(1);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
  });

  it("runs UserPromptSubmit rules for mixed Codex workflow prompts with edit authorization", async () => {
    await withAdapter("codex", async () => {
      await mainUserPromptSubmit(
        {
          session_id: "session-mixed-skill",
          transcript_path: transcriptPath,
          delivery_id: "delivery-mixed-skill",
          cwd: tempDir,
          prompt: "please call $agent-framework-quickpush and iterate by editing files to fix complaints",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).toHaveBeenCalledTimes(1);
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
    });
  });

  it("does not inject the planning contract while temporary hook injection is disabled", async () => {
    fs.writeFileSync(path.join(tempDir, "PLANS.md"), "# Planning Contract\n\nFollow it.");
    await mainUserPromptSubmit(
      {
        session_id: "session-plan",
        transcript_path: transcriptPath,
        delivery_id: "delivery-plan-first",
        cwd: tempDir,
        permission_mode: "plan",
        prompt: "please plan this",
      },
      encoder,
    );

    expect(mockExitAfterFlush).toHaveBeenLastCalledWith(0, "ok");

    await mainUserPromptSubmit(
      {
        session_id: "session-plan",
        transcript_path: transcriptPath,
        delivery_id: "delivery-plan-second",
        cwd: tempDir,
        permission_mode: "plan",
        prompt: "continue planning",
      },
      encoder,
    );

    expect(mockExitAfterFlush).toHaveBeenLastCalledWith(0, "ok");
  });

  it("commits Codex collaboration-mode plan state even when permission mode is default", async () => {
    await withAdapter("codex", async () => {
      await mainUserPromptSubmit(
        {
          session_id: "session-plan",
          transcript_path: transcriptPath,
          delivery_id: "delivery-codex-plan",
          cwd: tempDir,
          permission_mode: "default",
          collaboration_mode: "plan",
          prompt: "please plan this",
        },
        encoder,
      );

      const state = (await hookState("codex", "session-plan").snapshot())
        .stateSlices["plan.mode"].value as { active: boolean; mode: string; detection_source: string };
      expect(state).toMatchObject({
        active: true,
        mode: "plan",
        detection_source: "codex-collaboration-mode",
      });
    });
  });

  it("accepts Codex Implement the plan prompts with a populated planfile, writes implementation state, and skips sentiment", async () => {
    await withAdapter("codex", async () => {
      fs.mkdirSync(sessionDir, { recursive: true });
      const planPath = sessionPlanFile(sessionDir, "test-plan");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      const planContent = `Plan Name: test-plan\n\n## User Goal\nImplement x.\n\nPlanfile Path: ${planPath}\nPlan Name: test-plan`;
      fs.writeFileSync(planPath, planContent);
      const canonicalState = hookState("codex", "session-impl");
      await canonicalState.setStateSlice(
        "plan.current",
        "agent-framework://state/current-plan",
        { kind: "file", path: planPath, planName: "test-plan" },
      );

      await mainUserPromptSubmit(
        {
          session_id: "session-impl",
          transcript_path: transcriptPath,
          delivery_id: "delivery-impl",
          cwd: tempDir,
          prompt: "Implement the plan.",
        },
        codexEncoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockCheckPlanIntent).not.toHaveBeenCalled();
      const state = await canonicalState.load();
      expect(state.currentEditIntent).toBe(true);
      expect(state.currentPrediction?.intent).toContain("implementation phase has begun");
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "");
    });
  });

  it("blocks Codex implementation prompts when the stored planfile is empty", async () => {
    await withAdapter("codex", async () => {
      fs.mkdirSync(sessionDir, { recursive: true });
      const planPath = sessionPlanFile(sessionDir, "empty-plan");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "  \n");
      await hookState("codex", "session-impl-block").setStateSlice(
        "plan.current",
        "agent-framework://state/current-plan",
        { kind: "file", path: planPath, planName: "empty-plan" },
      );

      await mainUserPromptSubmit(
        {
          session_id: "session-impl-block",
          transcript_path: transcriptPath,
          delivery_id: "delivery-impl-block",
          cwd: tempDir,
          prompt: "Implement the plan.",
        },
        codexEncoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockCheckPlanIntent).not.toHaveBeenCalled();
      expect(mockExitAfterFlush).toHaveBeenCalledWith(
        0,
        expect.stringContaining('"decision":"block"'),
      );
    });
  });
});
