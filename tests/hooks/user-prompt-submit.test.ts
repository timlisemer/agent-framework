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
import { codexEncoder } from "../../adapters/codex/encoder.js";
import {
  getAgentFrameworkSessionDir,
  sessionCurrentPlanFile,
  sessionPlanFile,
  sessionPlanModeStateFile,
  sessionStateFile,
} from "../../src/utils/paths.js";

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

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "user-prompt-submit-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    sessionDir = getAgentFrameworkSessionDir({ transcriptPath });
  });

  afterEach(() => {
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("skips UserPromptSubmit rules for direct agent-framework slash commands", async () => {
    await mainUserPromptSubmit(
      {
        session_id: "session-slash",
        transcript_path: transcriptPath,
        cwd: tempDir,
        prompt: "/quickpush",
      },
      encoder,
    );

    expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
  });

  it("skips UserPromptSubmit rules for Codex agent-framework skill invocations", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await mainUserPromptSubmit(
        {
          session_id: "session-skill",
          transcript_path: transcriptPath,
          cwd: tempDir,
          prompt: "$agent-framework-quickpush",
        },
        encoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
    } finally {
      if (prev === undefined) {
        delete process.env.AGENT_FRAMEWORK_ADAPTER;
      } else {
        process.env.AGENT_FRAMEWORK_ADAPTER = prev;
      }
    }
  });

  it("still runs UserPromptSubmit rules for ordinary prompts", async () => {
    await mainUserPromptSubmit(
      {
        session_id: "session-normal",
        transcript_path: transcriptPath,
        cwd: tempDir,
        prompt: "please fix the bug",
      },
      encoder,
    );

    expect(mockEvaluateRulesForUserPromptSubmit).toHaveBeenCalledTimes(1);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "ok");
  });

  it("does not inject the planning contract while temporary hook injection is disabled", async () => {
    fs.writeFileSync(path.join(tempDir, "PLANS.md"), "# Planning Contract\n\nFollow it.");
    await mainUserPromptSubmit(
      {
        session_id: "session-plan",
        transcript_path: transcriptPath,
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
        cwd: tempDir,
        permission_mode: "plan",
        prompt: "continue planning",
      },
      encoder,
    );

    expect(mockExitAfterFlush).toHaveBeenLastCalledWith(0, "ok");
  });

  it("commits Codex collaboration-mode plan state even when permission mode is default", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      await mainUserPromptSubmit(
        {
          session_id: "session-plan",
          transcript_path: transcriptPath,
          cwd: tempDir,
          permission_mode: "default",
          collaboration_mode: "plan",
          prompt: "please plan this",
        },
        encoder,
      );

      const state = JSON.parse(
        fs.readFileSync(sessionPlanModeStateFile(sessionDir), "utf-8"),
      ) as { active: boolean; mode: string; detection_source: string };
      expect(state).toMatchObject({
        active: true,
        mode: "plan",
        detection_source: "codex-collaboration-mode",
      });
    } finally {
      if (prev === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = prev;
    }
  });

  it("validates Codex Implement the plan prompts, writes implementation state, and skips sentiment", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      const planPath = sessionPlanFile(sessionDir, "test-plan");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      const planContent = `Plan Name: test-plan\n\n## User Goal\nImplement x.\n\nPlanfile Path: ${planPath}\nPlan Name: test-plan`;
      fs.writeFileSync(planPath, planContent);
      fs.writeFileSync(
        sessionCurrentPlanFile(sessionDir),
        JSON.stringify({ kind: "file", path: planPath, planName: "test-plan" }) + "\n",
      );

      await mainUserPromptSubmit(
        {
          session_id: "session-impl",
          transcript_path: transcriptPath,
          cwd: tempDir,
          prompt: "Implement the plan.",
        },
        codexEncoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockCheckPlanIntent).toHaveBeenCalledWith(
        null,
        "Write",
        { content: planContent },
        expect.any(String),
        tempDir,
        "UserPromptSubmit",
        "exit",
        planPath,
      );
      const state = JSON.parse(fs.readFileSync(sessionStateFile(sessionDir), "utf-8")).data;
      expect(state.currentEditIntent).toBe(true);
      expect(state.currentPrediction.intent).toContain("implementation phase has begun");
      expect(mockExitAfterFlush).toHaveBeenCalledWith(0, "");
    } finally {
      if (prev === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = prev;
    }
  });

  it("blocks Codex implementation prompts when the stored plan fails validation", async () => {
    const prev = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
    mockCheckPlanIntent.mockResolvedValue({ approved: false, reason: "bad plan" });
    try {
      fs.mkdirSync(sessionDir, { recursive: true });
      const planPath = sessionPlanFile(sessionDir, "bad-plan");
      fs.mkdirSync(path.dirname(planPath), { recursive: true });
      fs.writeFileSync(planPath, "bad");
      fs.writeFileSync(
        sessionCurrentPlanFile(sessionDir),
        JSON.stringify({ kind: "file", path: planPath, planName: "bad-plan" }) + "\n",
      );

      await mainUserPromptSubmit(
        {
          session_id: "session-impl-block",
          transcript_path: transcriptPath,
          cwd: tempDir,
          prompt: "Implement the plan.",
        },
        codexEncoder,
      );

      expect(mockEvaluateRulesForUserPromptSubmit).not.toHaveBeenCalled();
      expect(mockExitAfterFlush).toHaveBeenCalledWith(
        0,
        expect.stringContaining('"decision":"block"'),
      );
    } finally {
      if (prev === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
      else process.env.AGENT_FRAMEWORK_ADAPTER = prev;
    }
  });
});
