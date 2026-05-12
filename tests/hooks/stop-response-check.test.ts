import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexEncoder } from "../../adapters/codex/encoder.js";
import { sessionCapturesFile, sessionCurrentPlanFile } from "../../src/utils/paths.js";

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

describe("mainStop Codex inline plan validation", () => {
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

  it("blocks invalid proposed plans before passing Stop", async () => {
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

    expect(mockExitAfterFlush).toHaveBeenCalledWith(
      0,
      expect.stringContaining("Plan validation failed: missing section"),
    );
    expect(fs.existsSync(sessionCurrentPlanFile(process.env.AGENT_FRAMEWORK_SESSION_DIR!))).toBe(false);
    const capture = JSON.parse(
      fs.readFileSync(sessionCapturesFile(process.env.AGENT_FRAMEWORK_SESSION_DIR!), "utf-8").trim(),
    ) as { plan_mode?: { active?: boolean; mode?: string; source?: string } };
    expect(capture.plan_mode).toMatchObject({
      active: true,
      mode: "plan",
      source: "codex-collaboration-mode",
    });
  });

  it("stores valid inline proposed plans in the current-plan sidecar", async () => {
    mockCheckPlanIntent.mockResolvedValue({ approved: true });

    await mainStop(
      {
        session_id: "session-stop",
        transcript_path: transcriptPath,
        cwd: tempDir,
        last_assistant_message: "<proposed_plan>\n## User Goal\nx\n</proposed_plan>",
      },
      codexEncoder,
    );

    const stored = JSON.parse(fs.readFileSync(sessionCurrentPlanFile(process.env.AGENT_FRAMEWORK_SESSION_DIR!), "utf-8"));
    expect(stored).toEqual({
      kind: "inline",
      content: "## User Goal\nx",
      source: "codex-proposed-plan",
    });
    expect(mockExitAfterFlush).toHaveBeenCalledWith(0, JSON.stringify({ continue: true }));
  });
});
