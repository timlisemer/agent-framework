import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { sessionCapturesFile, sessionCurrentPlanFile, sessionPlanModeStateFile } from "../../src/utils/paths.js";

vi.mock("../../src/utils/hook-bootstrap.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/hook-bootstrap.js")>(
    "../../src/utils/hook-bootstrap.js",
  );
  return {
    ...actual,
    exitAfterFlush: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("../../src/agents/hooks/plan-validate.js", () => ({
  checkPlanIntent: vi.fn(),
}));

import { mainStop } from "../../src/hooks/stop-response-check.js";
import { checkPlanIntent } from "../../src/agents/hooks/plan-validate.js";
import { exitAfterFlush } from "../../src/utils/hook-bootstrap.js";

const mockCheckPlanIntent = vi.mocked(checkPlanIntent);
const mockExitAfterFlush = vi.mocked(exitAfterFlush);

describe("mainStop Codex file-backed plan validation", () => {
  let tempDir: string;
  let transcriptPath: string;
  let prevSessionDir: string | undefined;
  let prevAdapter: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stop-plan-test-"));
    transcriptPath = path.join(tempDir, "transcript.jsonl");
    fs.writeFileSync(transcriptPath, "");
    prevSessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR;
    prevAdapter = process.env.AGENT_FRAMEWORK_ADAPTER;
    process.env.AGENT_FRAMEWORK_SESSION_DIR = path.join(tempDir, "session");
    process.env.AGENT_FRAMEWORK_ADAPTER = "codex";
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (prevSessionDir === undefined) delete process.env.AGENT_FRAMEWORK_SESSION_DIR;
    else process.env.AGENT_FRAMEWORK_SESSION_DIR = prevSessionDir;
    if (prevAdapter === undefined) delete process.env.AGENT_FRAMEWORK_ADAPTER;
    else process.env.AGENT_FRAMEWORK_ADAPTER = prevAdapter;
  });

  it("does not treat whole-message proposed_plan blocks as Stop plan exits", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: false, reason: "missing section" });
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "event_msg", payload: { collaboration_mode_kind: "plan" } }) + "\n",
    );

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
    const capture = JSON.parse(
      fs.readFileSync(sessionCapturesFile(process.env.AGENT_FRAMEWORK_SESSION_DIR!), "utf-8").trim(),
    ) as { plan_mode?: { active?: boolean; mode?: string; source?: string } };
    expect(capture.plan_mode).toMatchObject({
      active: true,
      mode: "plan",
      source: "codex-collaboration-mode",
    });
  });

  it("does not write a current-plan sidecar for proposed_plan Stop text", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify({ type: "event_msg", payload: { collaboration_mode_kind: "plan" } }) + "\n",
    );

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    expect(fs.existsSync(sessionCurrentPlanFile(process.env.AGENT_FRAMEWORK_SESSION_DIR!))).toBe(false);
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("does not validate proposed_plan text embedded in ordinary Stop prose", async () => {
    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "Use `<proposed_plan>...</proposed_plan>` for final plans.",
      },
      codexEncoder,
    );

    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("allows whole-message proposed_plan blocks outside plan mode without validating stale sidecar", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    const sessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR!;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      sessionCurrentPlanFile(sessionDir),
      JSON.stringify({ kind: "file", path: path.join(sessionDir, "plans", "stale-plan.md"), planName: "stale-plan" }) + "\n",
    );

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("does not validate proposed_plan Stop text when stored active plan mode exists", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    const sessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR!;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      sessionPlanModeStateFile(sessionDir),
      JSON.stringify({
        active: true,
        updatedAt: Date.now(),
        lastSource: "UserPromptSubmit",
        mode: "plan",
        detection_source: "codex-collaboration-mode",
        deliveredPlansMdHash: null,
        deliveredPlansMdAt: null,
      }) + "\n",
    );

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        permission_mode: "default",
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });

  it("does not validate inline plans when Codex transcript tail misses the plan marker", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true });
    const sessionDir = process.env.AGENT_FRAMEWORK_SESSION_DIR!;
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      sessionPlanModeStateFile(sessionDir),
      JSON.stringify({
        active: true,
        updatedAt: Date.now(),
        lastSource: "SessionStart",
        mode: "plan",
        detection_source: "codex-collaboration-mode",
        deliveredPlansMdHash: null,
        deliveredPlansMdAt: null,
      }) + "\n",
    );
    fs.writeFileSync(
      transcriptPath,
      Array.from({ length: 120 }, (_, i) =>
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "reasoning",
            encrypted_content: "x".repeat(600),
            index: i,
          },
        })
      ).join("\n") + "\n",
    );

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        permission_mode: "default",
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    expect(mockCheckPlanIntent).not.toHaveBeenCalled();
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });
});
